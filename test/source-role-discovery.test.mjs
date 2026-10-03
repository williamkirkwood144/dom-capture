import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const { discoverSourceRoles } = await import('../tools/source-role-discovery.mjs');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent('<!doctype html><html><body><header><nav aria-label="Primary"><a href="/">Home</a></nav></header><main><h1>Blog</h1><article class="card"><h2><a href="/story/">Story</a></h2><img src="/story.jpg" alt="Story home"><p>Excerpt</p></article><article class="card" style="display:none"><h2>Hidden duplicate</h2></article><nav aria-label="Pagination"><a href="?page=2">Next</a></nav></main><footer><a href="/privacy/">Privacy</a></footer></body></html>');
  let result = await discoverSourceRoles(page, { routeId: 'category', sourceKind: 'category_archive', routePath: '/blog/category/blog/' });
  const ids = result.roles.map(r => r.role_id);
  for (const id of ['document_body','header_primary','primary_navigation','main_content','page_heading_01','archive_card_01','archive_card_01_heading','archive_card_01_media_01','pagination','footer']) assert(ids.includes(id), 'missing category role '+id);
  assert(!ids.some(id => id.includes('hidden')), 'hidden clone was included');
  for (const r of result.roles) assert.equal(await page.locator(r.selector).count(), 1, 'selector must be unique: '+r.selector);

  await page.setContent('<!doctype html><html><body><main><article><h1>Property</h1><dl><dt>Bedrooms</dt><dd>3</dd></dl><section aria-label="Gallery"><img src="/home.jpg" alt="Front"></section><a href="/contact/">Enquire</a></article></main></body></html>');
  result = await discoverSourceRoles(page, { routeId: 'property', sourceKind: 'property', routePath: '/blog/property/property-one/' });
  const propertyIds = result.roles.map(r => r.role_id);
  for (const id of ['property_facts','property_gallery','primary_cta_01']) assert(propertyIds.includes(id), 'missing property role '+id);

  await page.setContent('<!doctype html><html><body><main><article><h1>Testimonial</h1><blockquote>Thoughtful advice.</blockquote><cite>Jane Doe</cite></article><iframe title="Form Website" src="https://api.leadconnectorhq.com/widget/form/example"></iframe></main></body></html>');
  result = await discoverSourceRoles(page, { routeId: 'testimonial', sourceKind: 'testimonial', routePath: '/blog/testimonial/jane-doe/' });
  const testimonialIds = result.roles.map(r => r.role_id);
  assert(testimonialIds.includes('testimonial_quote_01'));
  assert(testimonialIds.includes('testimonial_author_01'));
  assert.equal(result.formObservations[0].allowedOrigins[0], 'https://api.leadconnectorhq.com');

  await page.setContent('<!doctype html><html><body><div class="ct-inner-content"><div id="inner_content-2-17" class="ct-inner-content"><h2>Expanded archive heading one</h2><p>Full body archive content.</p><h3>Expanded archive heading two</h3><img src="/article.jpg" alt="Article image"></div></div></body></html>');
  result = await discoverSourceRoles(page, { routeId: 'category-blog', sourceKind: 'category_archive', routePath: '/blog/category/blog/' });
  const archiveRoot = result.roles.find(r => r.role_id === 'archive_content');
  assert(archiveRoot, 'category without main must expose a real archive content root');
  assert.equal(archiveRoot.selector, '#inner_content-2-17', 'must retain the uniquely observed source selector');
  const archiveIds = result.roles.map(r => r.role_id);
  assert(archiveIds.includes('content_heading_01') && archiveIds.includes('content_heading_02'), 'ordered observed headings are positive source roles');
  assert(archiveIds.includes('content_media_01'), 'visible source media is a positive role');
  const absentIds = (result.observed_absent || []).map(r => r.role_id);
  for (const id of ['semantic_landmark_main','page_heading','archive_cards','pagination']) assert(absentIds.includes(id), 'missing source role must be classified absent: '+id);
  assert.equal(result.status, 'observed', 'source absence is not a failed observation');
  assert.equal(result.unresolved.length, 0, 'only capture failures or ambiguous selectors remain unresolved');

  await page.setContent('<!doctype html><html><body><div class="ct-inner-content"><div id="inner_content-2-17" class="ct-inner-content"><p>First root</p></div><div id="inner_content-2-17" class="ct-inner-content"><p>Duplicate id root</p></div></div></body></html>');
  result = await discoverSourceRoles(page, { routeId: 'category-ambiguous', sourceKind: 'category_archive', routePath: '/blog/category/ambiguous/' });
  assert(!result.roles.some(r => r.role_id === 'archive_content'), 'ambiguous duplicate IDs must fail closed');
  assert(result.status === 'incomplete', 'ambiguous content roots must remain incomplete');

  await page.setContent('<!doctype html><html><body><p>No main</p></body></html>');
  result = await discoverSourceRoles(page, { routeId: 'missing', sourceKind: 'page', routePath: '/missing/' });
  assert.equal(result.status, 'incomplete');
  assert(result.unresolved.some(x => x.role_id === 'main_content'));
} finally {
  await browser.close();
}
console.log('source role discovery fixtures passed');
