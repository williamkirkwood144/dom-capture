import assert from 'node:assert/strict';
import { assetInventory, imageDecodeStatus, safeUrl, sha256, summarizeImageReadiness, validateConfig } from '../tools/evidence-runner.mjs';

assert.equal(safeUrl('https://example.com/a?token=abc&mode=view'), 'https://example.com/a?token=%5BREDACTED%5D&mode=%5BREDACTED%5D');
const config = { allowlist: ['https://example.com'], captures: [{ name: 'ok', url: 'https://example.com/a', selector: 'main' }] };
assert.equal(validateConfig(config), config);
assert.throws(() => validateConfig({ ...config, captures: [{ ...config.captures[0], url: 'https://other.example/a' }] }), /allowlisted/);
assert.throws(() => validateConfig({ ...config, captures: [{ ...config.captures[0], name: '../bad' }] }), /filesystem-safe/);
assert.throws(() => validateConfig({ ...config, captures: [{ ...config.captures[0], state: { actions: [{ action: 'evaluate', selector: 'main' }] } }] }), /invalid state action/);
assert.throws(() => validateConfig({ ...config, captures: [{ ...config.captures[0], url: 'https://user:password@example.com/a' }] }), /credential-free/);
assert.throws(() => validateConfig({ ...config, imageReadyTimeoutMs: 0 }), /invalid imageReadyTimeoutMs/);
assert.equal(validateConfig({ ...config, scrollSweep: true }).scrollSweep, true);
assert.throws(() => validateConfig({ ...config, scrollSweep: 'yes' }), /invalid scrollSweep/);
assert.equal(validateConfig({ ...config, captureViewport: true }).captureViewport, true);
assert.throws(() => validateConfig({ ...config, captureViewport: 'yes' }), /invalid captureViewport/);
assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.deepEqual(assetInventory('<img src="https://example.com/a.png?token=abc"><a href="#local">x</a><style>p{background:url(data:image/png;base64,abc)}</style>'), [{ url: 'data:', embedded: true }, { url: 'https://example.com/a.png?token=%5BREDACTED%5D', embedded: false }]);
assert.deepEqual(summarizeImageReadiness([
  { url: 'https://example.com/ready.png', status: 'loaded' },
  { url: 'https://example.com/broken.png?token=abc', status: 'failed', reason: 'decode rejected' },
  { url: 'data:image/png;base64,abc', status: 'timed-out' },
  { url: '', status: 'not-requested' },
]), {
  total: 4,
  loaded: 1,
  notRequested: 1,
  notRequestedDetail: [],
  failed: [{ url: 'https://example.com/broken.png?token=%5BREDACTED%5D', reason: 'decode rejected' }],
  timedOut: [{ url: 'data:' }],
  cssBackgroundImages: 'not-verified',
});
// A not-requested image that DOES have a URL (a hidden page-builder
// duplicate the browser correctly never fetched) is listed with its reason,
// not just counted — that's what makes it traceable to a real site image
// rather than the ordinary no-src case above.
assert.deepEqual(summarizeImageReadiness([
  { url: 'https://example.com/hidden.png?token=abc', status: 'not-requested', reason: 'not rendered (display:none in its ancestry at this viewport)' },
]), {
  total: 1,
  loaded: 0,
  notRequested: 1,
  notRequestedDetail: [{ url: 'https://example.com/hidden.png?token=%5BREDACTED%5D', reason: 'not rendered (display:none in its ancestry at this viewport)' }],
  failed: [],
  timedOut: [],
  cssBackgroundImages: 'not-verified',
});
let decodeCalls = 0;
assert.deepEqual(await imageDecodeStatus({
  currentSrc: 'https://example.com/complete.png',
  complete: true,
  naturalWidth: 1,
  getClientRects: () => [{}],
  decode: async () => { decodeCalls += 1; },
}, 20), { url: 'https://example.com/complete.png', status: 'loaded' });
assert.equal(decodeCalls, 1, 'completed images must still be decoded before capture');
assert.deepEqual(await imageDecodeStatus({
  currentSrc: 'https://example.com/broken.png',
  complete: true,
  naturalWidth: 0,
  getClientRects: () => [{}],
  decode: async () => { throw new Error('must not be called for a conclusively broken image'); },
}, 20), { url: 'https://example.com/broken.png', status: 'failed', reason: 'complete with zero natural width' });
// An element with no client rects is not rendered anywhere on the page (the
// element or an ancestor is display:none) — a page-builder duplicate hidden
// at the current breakpoint, most often. The browser has no reason to ever
// fetch it, so decode() would hang forever; it must be recognized before
// the decode race even starts, not timed out into it.
assert.deepEqual(await imageDecodeStatus({
  currentSrc: 'https://example.com/hidden.png',
  complete: false,
  naturalWidth: 0,
  getClientRects: () => [],
  decode: async () => { throw new Error('must not be called for an element with no client rects'); },
}, 20), { url: 'https://example.com/hidden.png', status: 'not-requested', reason: 'not rendered (display:none in its ancestry at this viewport)' });
console.log('evidence runner unit tests passed');
