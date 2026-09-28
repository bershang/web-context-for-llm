import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/extractor.js';

test('extracts an anchored HTML section and removes cookie UI noise', () => {
  const html = `<!doctype html><html><head><title>Demo Docs</title></head><body>
    <div class="cookie-banner">We use cookies. Accept Reject Preferences</div>
    <nav>Navigation noise</nav>
    <main>
      <section id="overview"><h1>Product Overview</h1><p>This public demo product routes customer requests to the correct support team and records structured context for downstream AI workflows.</p></section>
      <section id="pricing"><h2>Pricing</h2><p>Pricing content that should not be selected when the overview anchor is requested.</p></section>
    </main>
  </body></html>`;

  const result = htmlToText(html, 'https://example.com/docs#overview');
  assert.equal(result.extractionMethod, 'anchor');
  assert.match(result.text, /Product Overview/);
  assert.doesNotMatch(result.text, /Navigation noise/);
  assert.doesNotMatch(result.text, /Accept Reject Preferences/);
  assert.doesNotMatch(result.text, /Pricing content/);
});
