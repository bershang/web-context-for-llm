import { extractUrl } from './extractor.js';

const MAX_URLS = Number(process.env.MAX_URLS || 20);
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 150000);

function validateUrls(urls) {
  if (!Array.isArray(urls)) {
    const error = new Error('"urls" must be an array.');
    error.statusCode = 400;
    throw error;
  }

  const cleaned = [...new Set(urls.map((url) => String(url || '').trim()).filter(Boolean))];

  if (!cleaned.length) {
    const error = new Error('At least one URL is required.');
    error.statusCode = 400;
    throw error;
  }

  if (cleaned.length > MAX_URLS) {
    const error = new Error(`A maximum of ${MAX_URLS} URLs is allowed.`);
    error.statusCode = 400;
    throw error;
  }

  return cleaned;
}

function formatSource(source, sourceNumber) {
  return [
    `=== SOURCE ${sourceNumber} ===`,
    `Title: ${source.title}`,
    `URL: ${source.finalUrl || source.url}`,
    '',
    source.text,
    '',
    `=== END SOURCE ${sourceNumber} ===`
  ].join('\n');
}

export async function buildContext(inputUrls) {
  const urls = validateUrls(inputUrls);
  const sources = [];
  const successful = [];
  const warnings = [];

  // Sequential on purpose: gentler on remote sites and easier to diagnose in a demo.
  for (const url of urls) {
    try {
      const extracted = await extractUrl(url);
      const source = { success: true, ...extracted };
      sources.push(source);
      successful.push(source);
    } catch (error) {
      sources.push({
        success: false,
        url,
        error: error.message
      });
      warnings.push(`${url}: ${error.message}`);
    }
  }

  if (!successful.length) {
    const error = new Error('No usable content could be extracted from any URL.');
    error.statusCode = 422;
    error.details = sources;
    throw error;
  }

 const context = successful
  .map((source, index) => formatSource(source, index + 1))
  .join('\n\n');

  if (context.length > MAX_CONTEXT_CHARS) {
    const error = new Error(
      `Generated context has ${context.length} characters and exceeds the configured limit of ${MAX_CONTEXT_CHARS}.`
    );
    error.statusCode = 413;
    error.details = {
      totalCharacters: context.length,
      maxCharacters: MAX_CONTEXT_CHARS,
      sources
    };
    throw error;
  }

  return {
    sources,
    warnings,
    totalUrls: urls.length,
    successfulUrls: successful.length,
    failedUrls: urls.length - successful.length,
    totalCharacters: context.length,
    context
  };
}
