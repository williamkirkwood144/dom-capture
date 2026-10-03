import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { discoverSourceRoles } from '../tools/source-role-discovery.mjs';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:390,height:900}});
 await page.setContent('<!doctype html><html><head><title>Jane Doe - Residence</title></head><body><section id="section-3-17" class="header-section"><nav id="_nav_menu-60-17">Home</nav></section><div id="div_block-56-17" class="smooth-content"><div id="inner_content-2-17" class="ct-inner-content"><p class="wp-block-paragraph">A source testimonial quote with enough text to identify this paragraph as the quote.</p><p class="wp-block-paragraph"></p></div></div><a id="link-69-17">leave a message</a><section id="section-46-17" class="footer-section"><nav id="_nav_menu-49-17">Privacy</nav></section></body></html>');
 let result=await discoverSourceRoles(page,{routeId:'testimonial',sourceKind:'testimonial',routePath:'/blog/testimonial/jane-doe/'});
 assert.equal(result.status,'observed');
 assert(result.roles.some(x=>x.role_id==='testimonial_content'&&x.selector==='#inner_content-2-17'));
 assert(result.roles.some(x=>x.role_id==='testimonial_quote_01'&&x.selector==='#inner_content-2-17 > p:nth-of-type(1)'));
 const absent=result.observed_absent.map(x=>x.role_id);
 for(const id of ['semantic_main','page_heading','testimonial_attribution','testimonial_position'])assert(absent.includes(id),'missing explicit absence '+id);
 assert(result.roles.some(x=>x.role_id==='primary_cta_01'));
 assert(result.roles.some(x=>x.role_id==='header_primary'));
 assert(result.roles.some(x=>x.role_id==='footer'));
 await page.setContent('<body><div id="inner_content-a">First testimonial content</div><div id="inner_content-b">Second testimonial content</div></body>');
 result=await discoverSourceRoles(page,{routeId:'testimonial',sourceKind:'testimonial',routePath:'/blog/testimonial/x/'});
 assert.equal(result.status,'incomplete');
 assert(!result.roles.some(x=>x.role_id==='testimonial_content'));
 assert(result.unresolved.some(x=>x.role_id==='testimonial_content'));
} finally { await browser.close(); }
console.log('testimonial role discovery tests passed');
