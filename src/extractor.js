import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { validatePublicUrl } from './url-safety.js';

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 10000);
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 3000000);
const MAX_REDIRECTS = 5;

const NOISE_SELECTORS = [
  'script',
  'style',
  'nav',
  'footer',
  'header',
  'noscript',
  'svg',
  'canvas',
  'iframe',
  'template',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[id*="onetrust" i]',
  '[class*="onetrust" i]',
  '[id*="gdpr" i]',
  '[class*="gdpr" i]',
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
  '.cc-window',
  '.cky-consent-container'
].join(',');

function normalizeText(text = '') {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([.!?])(["“”'’]?)(?=[A-ZÁÉÍÓÚÑÜ])/g, '$1$2 ')
    .trim();
}

function removeNoise(root) {
  root.querySelectorAll?.(NOISE_SELECTORS).forEach((element) => element.remove());
}

function toStructuredText(root) {
  const clone = root.cloneNode(true);

  removeNoise(clone);

  clone.querySelectorAll('br').forEach((element) => {
    element.replaceWith('\n');
  });

  clone
    .querySelectorAll(
      'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, section, article'
    )
    .forEach((element) => {
      element.insertAdjacentText('beforebegin', '\n');
      element.insertAdjacentText('afterend', '\n');
    });

  return normalizeText(clone.textContent || '');
}

function removeConsentText(text) {
  const blocks = text.split(/\n{2,}/);

  return blocks
    .filter((block) => {
      const value = block
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      const mentionsCookies = /\bcookies?\b/.test(value);

      const hasConsentActions =
        /(aceptar|rechazar|ajustes|preferencias|accept|reject|preferences|settings)/.test(
          value
        );

      return !(mentionsCookies && hasConsentActions);
    })
    .join('\n\n');
}

function dedupeExactBlocks(text) {
  const seen = new Set();

  return text
    .split(/\n{2,}/)
    .filter((block) => {
      const key = block
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      if (!key) return false;

      // Keep short headings/labels even when repeated.
      if (key.length < 30) return true;

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .join('\n\n');
}

function findAnchorRoot(document, url) {
  const hash = new URL(url).hash;

  if (!hash) return null;

  let anchorName;

  try {
    anchorName = decodeURIComponent(hash.slice(1));
  } catch {
    anchorName = hash.slice(1);
  }

  if (!anchorName) return null;

  const target =
    document.getElementById(anchorName) ||
    [...document.querySelectorAll('[name]')].find(
      (element) => element.getAttribute('name') === anchorName
    );

  if (!target) return null;

  if (target.matches('section, article, main')) {
    return target;
  }

  const semanticParent = target.closest('section, article');

  if (semanticParent) {
    return semanticParent;
  }

  return target.parentElement || target;
}

function htmlToText(html, url) {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  removeNoise(document);

  let title = normalizeText(
    document.querySelector('title')?.textContent || ''
  );

  let text = '';
  let extractionMethod = 'readability';

  // If the URL contains an anchor, try extracting that section first.
  const anchorRoot = findAnchorRoot(document, url);

  if (anchorRoot) {
    const anchorText = toStructuredText(anchorRoot);

    if (anchorText.length >= 40) {
      text = anchorText;
      extractionMethod = 'anchor';
    }
  }

  // Otherwise use Mozilla Readability for main-content extraction.
  if (!text) {
    try {
      const parsed = new Readability(
        document.cloneNode(true)
      ).parse();

      if (parsed?.content?.trim()) {
        title = normalizeText(parsed.title || title);

        const parsedDocument = new JSDOM(
          parsed.content,
          { url }
        ).window.document;

        text = toStructuredText(parsedDocument.body);
      } else if (parsed?.textContent?.trim()) {
        title = normalizeText(parsed.title || title);
        text = normalizeText(parsed.textContent);
      }
    } catch {
      // Continue to the fallback extractor.
    }
  }

  if (!text || text.length < 80) {
    extractionMethod = 'main/body fallback';

    const fallbackDocument = new JSDOM(
      html,
      { url }
    ).window.document;

    removeNoise(fallbackDocument);

    const root =
      fallbackDocument.querySelector('main, article') ||
      fallbackDocument.body;

    text = toStructuredText(root);
  }

  text = dedupeExactBlocks(
    removeConsentText(
      normalizeText(text)
    )
  );

  return {
    title: title || new URL(url).hostname,
    text,
    extractionMethod
  };
}

function jsonToText(value) {
  return JSON.stringify(value, null, 2);
}

async function readLimitedBody(response) {
  const reader = response.body?.getReader();

  if (!reader) {
    return Buffer.from(await response.arrayBuffer());
  }

  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    total += value.byteLength;

    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();

      const error = new Error(
        `Response exceeded ${MAX_RESPONSE_BYTES} bytes.`
      );

      error.statusCode = 413;
      throw error;
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

async function safeFetch(rawUrl) {
  let current = await validatePublicUrl(rawUrl);

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS
    );

    let response;

    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'WebContextForLLM/1.0',
          Accept:
            'text/html,application/json,text/plain;q=0.9,*/*;q=0.5'
        }
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeoutError = new Error(
          `Timeout after ${FETCH_TIMEOUT_MS} ms.`
        );

        timeoutError.statusCode = 504;
        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      const location = response.headers.get('location');

      if (!location) {
        const error = new Error(
          `Redirect without Location header from ${current.href}`
        );

        error.statusCode = 502;
        throw error;
      }

      if (redirectCount === MAX_REDIRECTS) {
        const error = new Error('Too many redirects.');
        error.statusCode = 508;
        throw error;
      }

      current = await validatePublicUrl(
        new URL(location, current).href
      );

      continue;
    }

    return {
      response,
      finalUrl: current.href
    };
  }

  throw new Error('Unable to fetch URL.');
}

export async function extractUrl(rawUrl) {
  const startedAt = Date.now();

  // Preserve the requested anchor because URL fragments are not sent over HTTP.
  const requestedHash = new URL(rawUrl).hash;

  const { response, finalUrl } = await safeFetch(rawUrl);

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();

  if (!response.ok) {
    const error = new Error(
      `HTTP ${response.status} ${response.statusText}`
    );

    error.statusCode = 502;
    throw error;
  }

  const body = await readLimitedBody(response);
  const rawText = body.toString('utf8');

  // Re-attach the anchor for content extraction.
  const effectiveUrl = new URL(finalUrl);

  if (requestedHash) {
    effectiveUrl.hash = requestedHash;
  }

  let title = effectiveUrl.hostname;
  let text = '';
  let extractionMethod = 'plain text';

  if (
    contentType.includes('application/json') ||
    contentType.includes('+json')
  ) {
    extractionMethod = 'json';

    try {
      const json = JSON.parse(rawText);

      text = jsonToText(json);

      title =
        json?.title?.rendered ||
        json?.title ||
        title;
    } catch {
      text = normalizeText(rawText);
      extractionMethod = 'json fallback';
    }
  } else if (
    contentType.includes('text/html') ||
    /<html[\s>]/i.test(rawText)
  ) {
    const extracted = htmlToText(
      rawText,
      effectiveUrl.href
    );

    title = extracted.title;
    text = extracted.text;
    extractionMethod = extracted.extractionMethod;
  } else {
    text = normalizeText(rawText);
  }

  if (!text) {
    const error = new Error(
      'The URL responded successfully but no usable text was extracted.'
    );

    error.statusCode = 422;
    throw error;
  }

  return {
    url: rawUrl,
    finalUrl: effectiveUrl.href,
    status: response.status,
    contentType: contentType || 'unknown',
    title: normalizeText(String(title)),
    text,
    characters: text.length,
    extractionMethod,
    elapsedMs: Date.now() - startedAt
  };
}
// Exported for deterministic unit testing of the normalization pipeline without network access.
export { htmlToText };
