import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicUrl } from '../src/url-safety.js';

for (const url of [
  'http://127.0.0.1/',
  'http://10.0.0.1/',
  'http://192.168.1.10/',
  'http://169.254.169.254/latest/meta-data/',
  'http://[::1]/',
  'file:///etc/passwd',
  'http://user:pass@example.com/'
]) {
  test(`rejects unsafe URL: ${url}`, async () => {
    await assert.rejects(() => validatePublicUrl(url));
  });
}
