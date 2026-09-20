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
  failed: [{ url: 'https://example.com/broken.png?token=%5BREDACTED%5D', reason: 'decode rejected' }],
  timedOut: [{ url: 'data:' }],
  cssBackgroundImages: 'not-verified',
});
let decodeCalls = 0;
assert.deepEqual(await imageDecodeStatus({
  currentSrc: 'https://example.com/complete.png',
  complete: true,
  naturalWidth: 1,
  decode: async () => { decodeCalls += 1; },
}, 20), { url: 'https://example.com/complete.png', status: 'loaded' });
assert.equal(decodeCalls, 1, 'completed images must still be decoded before capture');
assert.deepEqual(await imageDecodeStatus({
  currentSrc: 'https://example.com/broken.png',
  complete: true,
  naturalWidth: 0,
  decode: async () => { throw new Error('must not be called for a conclusively broken image'); },
}, 20), { url: 'https://example.com/broken.png', status: 'failed', reason: 'complete with zero natural width' });
console.log('evidence runner unit tests passed');
