process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_REQUEST_TIMEOUT_MS = '10';

import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;

test('generateWithGemini fails fast when the request never resolves', async () => {
  globalThis.fetch = (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(options.signal.reason ?? new Error('Aborted'));
    });
  });

  try {
    const { generateWithGemini, resetModelCache } = await import('../src/gemini.js');
    resetModelCache();

    await assert.rejects(
      () => generateWithGemini('Write a product description.'),
      /timed out after 10ms/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});