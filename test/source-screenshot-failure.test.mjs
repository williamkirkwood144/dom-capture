import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureScreenshotWithSnapshot } from '../tools/evidence-runner.mjs';

const outputDir = await mkdtemp(path.join(os.tmpdir(), 'source-shot-failure-'));
try {
  const rawHtml = '<!doctype html><input type="email" name="email" value="private">';
  const sanitizedHtml = '<!doctype html><input type="email" name="email" value="[REDACTED]">';
  const events = [];
  let evaluation = 0;
  let screenshotAttempts = 0;
  const page = {
    async evaluate(_fn, arg) {
      evaluation += 1;
      if (evaluation === 1) { events.push('dom-read'); return rawHtml; }
      if (typeof arg === 'string') { events.push('sanitize'); return sanitizedHtml; }
      events.push('font-state');
      return { fontStatus: 'loaded', fontsReady: true, fontErrors: [] };
    },
    async screenshot(options) {
      screenshotAttempts += 1;
      events.push('png-attempt');
      assert.equal(options.fullPage, true);
      const files = await readdir(outputDir);
      assert(files.some(name => name.endsWith('.snapshot.html')), 'sanitized DOM must be persisted before PNG');
      throw new Error('page.screenshot: Timeout 30000ms exceeded; waiting for fonts to load; fonts loaded');
    },
  };
  const record = {};
  const result = await captureScreenshotWithSnapshot(page, {
    outputDir, name: 'route-w390', record, fullPage: true, timeoutMs: 30000,
  });
  assert.equal(result.status, 'failed');
  assert.equal(screenshotAttempts, 1, 'a screenshot error must not trigger a second screenshot attempt');
  assert.deepEqual(events.slice(0, 3), ['dom-read', 'sanitize', 'font-state']);
  assert.equal(record.diagnosticScreenshot, undefined, 'a failed screenshot must not be recorded as PNG evidence');
  assert.equal(record.screenshotFailure.attempts, 1);
  assert.equal(record.screenshotFailure.fontStatus, 'loaded');
  assert.equal(record.screenshotFailure.fontsReady, true);
  assert.match(record.screenshotFailure.error, /Timeout 30000ms exceeded/);
  const snapshotName = record.diagnosticSnapshot.path;
  assert.equal(await readFile(path.join(outputDir, snapshotName), 'utf8'), sanitizedHtml);
  assert.deepEqual((await readdir(outputDir)).filter(name => name.endsWith('.png')), []);
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
console.log('source screenshot failure contract passed');
