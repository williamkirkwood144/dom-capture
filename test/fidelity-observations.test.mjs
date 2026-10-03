import assert from 'node:assert/strict';
import { observeForms } from '../tools/fidelity-observations.mjs';

const origin = 'https://api.leadconnectorhq.com';
const frame = {
  url: () => origin + '/widget/form/fixture',
  waitForSelector: async (selector, options) => {
    assert.equal(selector, 'form');
    assert.equal(options.state, 'visible');
    assert.equal(options.timeout, 30000);
  },
  evaluate: async () => ({
    controls: [{ tag: 'INPUT', type: 'email', name: 'email', required: true }],
    statuses: [],
    scroll: { x: 0, y: 0 },
    submission: 'never_attempted',
    validation: 'read_only_validity_no_events',
    success: 'unobserved',
    error: 'unobserved',
  }),
};
const target = {
  count: async () => 1,
  // Locator.contentFrame() is a FrameLocator, not a Frame.
  contentFrame: async () => ({}),
  elementHandle: async () => ({ contentFrame: async () => frame }),
};
const page = { locator: selector => {
  assert.equal(selector, '#lead');
  return target;
} };
const specs = [{ role_id: 'lead_form', selector: '#lead', allowedOrigins: [origin], waitForSelector: 'form' }];
const forms = await observeForms(page, specs);
assert.equal(forms.length, 1);
assert.equal(forms[0].frame_origin, origin);
assert.equal(forms[0].frame_path, '/widget/form/fixture');
assert.deepEqual(forms[0].controls, [{ tag: 'INPUT', type: 'email', name: 'email', required: true }]);
assert.equal(forms[0].submission, 'never_attempted');

const missingPage = { locator: () => ({ count: async () => 0 }) };
await assert.rejects(() => observeForms(missingPage, specs), /unique/);
console.log('form-frame API fail-first regression passed');
