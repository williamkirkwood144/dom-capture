#!/usr/bin/env node
/*
 * DOM Capture evidence runner. MIT; see ../LICENSE.
 *
 * This is deliberately a configuration-driven local tool. It does not use the
 * extension, upload anything, or accept arbitrary JavaScript from a config.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { observe, actions, freezeVideoPhase, observeForms } from './fidelity-observations.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REDACTED = '[REDACTED]';
const SENSITIVE = /pass(?:word)?|secret|token|auth|api[-_]?key|card|cc-|cvv|ssn|social|email|e-mail|phone|mobile/i;
export const MANIFEST_VERSION = 2;

export function safeUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, REDACTED);
  return url.toString();
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('configuration must be an object');
  if (!Array.isArray(config.allowlist) || !config.allowlist.length) throw new Error('allowlist must contain one or more exact origins');
  const origins = new Set(config.allowlist.map((value) => new URL(value).origin));
  if (!Array.isArray(config.captures) || !config.captures.length) throw new Error('captures must be a non-empty array');
  for (const [index, capture] of config.captures.entries()) {
    if (!capture?.name || !/^[a-zA-Z0-9_-]+$/.test(capture.name)) throw new Error(`captures[${index}].name must be filesystem-safe`);
    if (typeof capture.url !== 'string' || typeof capture.selector !== 'string' || !capture.selector.trim()) throw new Error(`captures[${index}] needs url and selector`);
    const url = new URL(capture.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !origins.has(url.origin)) {
      throw new Error(`captures[${index}] URL is not an allowlisted credential-free HTTP(S) origin`);
    }
    const vp = capture.viewport || config.viewport || { width: 1280, height: 900 };
    if (!Number.isInteger(vp.width) || !Number.isInteger(vp.height) || vp.width < 1 || vp.height < 1 || vp.width > 5000 || vp.height > 5000) throw new Error(`captures[${index}] has an invalid viewport`);
    const imageReadyTimeoutMs = capture.imageReadyTimeoutMs ?? config.imageReadyTimeoutMs ?? 10000;
    if (!Number.isInteger(imageReadyTimeoutMs) || imageReadyTimeoutMs < 1 || imageReadyTimeoutMs > 30000) throw new Error(`captures[${index}] has an invalid imageReadyTimeoutMs`);
    const scrollSweep = capture.scrollSweep ?? config.scrollSweep;
    if (scrollSweep !== undefined && typeof scrollSweep !== 'boolean') throw new Error(`captures[${index}] has an invalid scrollSweep`);
    const captureViewport = capture.captureViewport ?? config.captureViewport;
    if (captureViewport !== undefined && typeof captureViewport !== 'boolean') throw new Error(`captures[${index}] has an invalid captureViewport`);
    for (const action of capture.state?.actions || []) {
      if (!['click', 'hover', 'focus', 'touch', 'key', 'scroll', 'diagnostic_font_size', 'video_seek', 'video_play'].includes(action.action) || (!['key','scroll'].includes(action.action) && typeof action.selector !== 'string')) throw new Error(`captures[${index}] has an invalid state action`);
    }
  }
  if (new Set(config.captures.map(c=>c.name)).size!==config.captures.length) throw Error('duplicate capture names');
  for (const c of config.captures) {
    if(c.motion && (!Array.isArray(c.motion.sampleMs)||c.motion.sampleMs.length<5||c.motion.sampleMs.some(t=>!Number.isFinite(t)||t<0||t>30000))) throw Error('motion requires bounded five-phase samples');
    if(c.mode && !['static','interaction','motion'].includes(c.mode)) throw Error('unsupported capture mode');
  }
  return config;
}

function sensitiveSelector() {
  return 'input, textarea, select';
}

// Runs in the page. It masks controls before screenshots and sanitizes captured
// markup before it leaves the browser context.
function redactInPage(html) {
  const sensitive = (el) => el.type === 'password' || /pass(?:word)?|secret|token|auth|api[-_]?key|card|cc-|cvv|ssn|social|email|e-mail|phone|mobile/i.test([el.name, el.id, el.autocomplete, el.placeholder].filter(Boolean).join(' '));
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('input, textarea, select')) {
    if (!sensitive(el)) continue;
    el.setAttribute('value', '[REDACTED]');
    if (el.localName === 'textarea') el.textContent = '[REDACTED]';
    if (el.localName === 'select') for (const option of el.options) {
      option.selected = false;
      option.value = '[REDACTED]';
      option.textContent = '[REDACTED]';
    }
  }
  // Query strings often carry tokens. Redact their values in attributes,
  // comments and style text without changing URL path/origin evidence.
  return '<!doctype html>\n' + doc.documentElement.outerHTML
    .replace(/([?&][A-Za-z0-9_.~-]+)=([^&#"'\s<>]*)/g, '$1=[REDACTED]');
}

async function maskLiveSensitiveControls(page) {
  await page.evaluate(() => {
    const sensitive = (el) => el.type === 'password' || /pass(?:word)?|secret|token|auth|api[-_]?key|card|cc-|cvv|ssn|social|email|e-mail|phone|mobile/i.test([el.name, el.id, el.autocomplete, el.placeholder].filter(Boolean).join(' '));
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (!sensitive(el)) continue;
      if ('value' in el) el.value = '[REDACTED]';
      el.style.setProperty('color', 'transparent', 'important');
      el.style.setProperty('text-shadow', '0 0 8px #444', 'important');
    }
  });
}

function enforceBounds(box, bounds = {}) {
  if (!box || box.width <= 0 || box.height <= 0) throw new Error('target is not visible');
  const rules = [['minWidth', 'width', (a, b) => a < b], ['maxWidth', 'width', (a, b) => a > b], ['minHeight', 'height', (a, b) => a < b], ['maxHeight', 'height', (a, b) => a > b]];
  for (const [rule, field, fails] of rules) if (bounds[rule] !== undefined && fails(box[field], bounds[rule])) throw new Error(`target ${field} ${box[field]} violates ${rule}=${bounds[rule]}`);
}

function validateFinalUrl(value, allowlist, requested) {
  const finalUrl = new URL(value);
  if (!['http:', 'https:'].includes(finalUrl.protocol) || finalUrl.username || finalUrl.password || !allowlist.has(finalUrl.origin)) throw new Error('final URL is not an allowlisted credential-free HTTP(S) origin');
  if (safeUrl(finalUrl.href) !== safeUrl(requested)) throw new Error(`redirect rejected: ${safeUrl(finalUrl.href)}`);
  return safeUrl(finalUrl.href);
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function assetInventory(html) {
  const assets = [];
  const seen = new Set();
  const re = /\b(?:src|href|poster|data|background)=["']([^"']+)["']|url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi;
  for (const match of html.matchAll(re)) {
    const url = match[1] || match[2];
    if (/^#/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    if (/^data:/i.test(url)) assets.push({ url: 'data:', embedded: true });
    else {
      try { assets.push({ url: safeUrl(url), embedded: false }); } catch { assets.push({ url: '[UNPARSEABLE]', embedded: false }); }
    }
  }
  return assets.sort((a, b) => a.url.localeCompare(b.url));
}

export function safeEvidenceAssetUrl(value) {
  if (/^data:/i.test(value)) return 'data:';
  try { return safeUrl(value); } catch { return '[UNPARSEABLE]'; }
}

// Kept pure so receipt behavior is unit-testable without starting a browser.
export function summarizeImageReadiness(images) {
  const failed = images.filter((image) => image.status === 'failed');
  const timedOut = images.filter((image) => image.status === 'timed-out');
  const notRequested = images.filter((image) => image.status === 'not-requested');
  return {
    total: images.length,
    loaded: images.filter((image) => image.status === 'loaded').length,
    notRequested: notRequested.length,
    // Listed (not just counted) so a not-rendered site-owned image is
    // traceable in the record rather than silently dropped into a number —
    // most not-requested images are simply <img> tags with no src, which
    // carry no reason.
    notRequestedDetail: notRequested.filter((image) => image.url).map((image) => ({ url: safeEvidenceAssetUrl(image.url), reason: image.reason })),
    failed: failed.map((image) => ({ url: safeEvidenceAssetUrl(image.url), reason: image.reason })),
    timedOut: timedOut.map((image) => ({ url: safeEvidenceAssetUrl(image.url) })),
    // CSS backgrounds can be painted by the target, but are not HTMLImageElements
    // and therefore have no decode() signal exposed to this gate.
    cssBackgroundImages: 'not-verified',
  };
}

// This function is also serialized into Playwright's page context below.
export async function imageDecodeStatus(img, timeoutMs) {
  const url = img.currentSrc || img.src || '';
  if (!url) return { url, status: 'not-requested' };
  // getClientRects() is empty exactly when the element or an ancestor is
  // display:none — unlike offsetParent, it isn't also thrown off by
  // position:fixed, and unlike a zero-size boundingClientRect it doesn't
  // false-positive on visibility:hidden/opacity:0 (which still paint an
  // area and so can legitimately decode). A page-builder duplicate marked
  // hidden at every breakpoint (e.g. Elementor's elementor-hidden-* classes
  // stacked to cover desktop/laptop/tablet/mobile all at once) never gets a
  // box, so native `loading="lazy"` never sees it near any viewport and
  // never fetches it — confirmed by probing goodhandsplumbing.com.au's own
  // markup. Waiting on it is unwinnable, and the browser never asked for it
  // either, so it is a not-requested, not a failure of the site's imagery.
  if (img.getClientRects().length === 0) {
    return { url, status: 'not-requested', reason: 'not rendered (display:none in its ancestry at this viewport)' };
  }
  // A completed resource with no intrinsic width is conclusively broken. Avoid
  // relying on decode() for this case, as browser behavior varies after errors.
  if (img.complete && img.naturalWidth === 0) {
    return { url, status: 'failed', reason: 'complete with zero natural width' };
  }
  let timer;
  const outcome = await Promise.race([
    Promise.resolve().then(() => img.decode()).then(() => 'loaded', () => 'failed'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timed-out'), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (outcome === 'loaded' && img.naturalWidth > 0) return { url, status: 'loaded' };
  if (outcome === 'timed-out') return { url, status: 'timed-out' };
  return { url, status: 'failed', reason: 'decode rejected or image has zero natural width' };
}

async function waitForTargetImages(target, timeoutMs) {
  const images = [];
  if (await target.evaluate((el) => el.matches('img'))) images.push(target);
  const descendants = target.locator('img');
  for (let index = 0, count = await descendants.count(); index < count; index += 1) images.push(descendants.nth(index));
  const results = await Promise.all(images.map((image) => image.evaluate(imageDecodeStatus, timeoutMs)));
  return summarizeImageReadiness(results);
}

async function applyState(page, state = {}) {
  for (const step of state.actions || []) {
    const locator = page.locator(step.selector).first();
    if (step.action === 'click') await locator.click();
    if (step.action === 'hover') await locator.hover();
    if (step.action === 'focus') await locator.focus();
  }
  if (state.waitMs) await page.waitForTimeout(Math.min(Math.max(state.waitMs, 0), 10000));
}

// The capture viewport is capped (see validateConfig) well below the height of
// many real pages, so a `loading="lazy"` image below that fold never enters
// the layout viewport on its own. Two separate things gate on proximity to
// the *current* scroll position, not just having been scrolled past once:
// the fetch (gated by the standard lazy-loading distance threshold) and,
// separately, the actual decode/raster (Chromium defers it for off-screen
// lazy images even after the bytes have arrived — confirmed by probing: an
// image can already show a nonzero naturalWidth from a header-only partial
// read while `decode()` never settles until the image is genuinely near the
// viewport). So it is not enough to scroll past a position and move on —
// each stop must explicitly decode() the images that just became reachable
// while still parked there, because a completed decode does stick after
// scrolling away again (also confirmed by probing). Scrolling back to the
// top at the end restores the position a fresh load would show, without
// undoing that work.
async function scrollThroughPage(page, { stepDelayMs = 300, decodeTimeoutMs = 4000 } = {}) {
  return await page.evaluate(async ({ delay, decodeTimeoutMs }) => {
    const decodeSettledImages = async () => {
      const imgs = [...document.querySelectorAll('img')];
      await Promise.all(imgs.map((img) => Promise.race([
        Promise.resolve().then(() => img.decode()).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, decodeTimeoutMs)),
      ])));
    };
    const step = () => Math.max(window.innerHeight || 800, 1);
    let y = 0;const trace=[];
    let previousHeight = -1;
    // Bounded by document height, which can grow as lazy sections mount; a
    // generous iteration cap keeps this from looping forever on a page that
    // never stabilizes.
    for (let i = 0; i < 200; i += 1) {
      const scrollHeight = document.documentElement.scrollHeight;
      if (y >= scrollHeight && scrollHeight === previousHeight) break;
      previousHeight = scrollHeight;
      window.scrollTo({left:0,top:y,behavior:'instant'});trace.push({action:'scroll',requested:{x:0,y},actual:{x:scrollX,y:scrollY},documentHeight:scrollHeight,at_ms:performance.now()});
      await new Promise((resolve) => setTimeout(resolve, delay));
      await decodeSettledImages();
      y += step();
    }
    window.scrollTo({left:0,top:0,behavior:'instant'});
    await new Promise((resolve) => setTimeout(resolve, delay));
    trace.push({action:'scroll',requested:{x:0,y:0},actual:{x:scrollX,y:scrollY},documentHeight:document.documentElement.scrollHeight,at_ms:performance.now()});return trace;
  }, { delay: stepDelayMs, decodeTimeoutMs });
}

async function main() {
  const [configFile, outputArg] = process.argv.slice(2);
  if (!configFile) throw new Error('Usage: npm run evidence -- evidence.config.json [output-dir]');
  const config = validateConfig(JSON.parse(await readFile(configFile, 'utf8')));
  const allowlist = new Set(config.allowlist.map((value) => new URL(value).origin));
  const output = path.resolve(outputArg || 'evidence-output');
  await mkdir(output, { recursive: true });
  const captureJs = await readFile(path.join(here, '..', 'extension', 'src', 'capture.js'), 'utf8');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: process.env.DOM_CAPTURE_BROWSER_CHANNEL || 'chrome' });
  const manifest = { manifestVersion: MANIFEST_VERSION, generatedAt: new Date().toISOString(), captures: [] };
  try {
    for (const item of config.captures) {
      const viewport = item.viewport || config.viewport || { width: 1280, height: 900 };
      const context = await browser.newContext({ viewport, deviceScaleFactor: item.dpr || 1, hasTouch: item.hasTouch || false, reducedMotion: item.reducedMotion || 'no-preference' });
      const page = await context.newPage();
      const record = { name: item.name, source: { url: safeUrl(item.url), path: new URL(item.url).pathname }, selector: item.selector, state: item.state || {}, warnings: [], timing: {} };
      const resourceTasks=[];record.resourceResponses=[];
      page.on('response',response=>{const type=response.request().resourceType();if(!['stylesheet','font'].includes(type))return;const index=resourceTasks.length;resourceTasks.push((async()=>{try{const bytes=await response.body();const file=`${item.name}.resource-${index}.bin`;await writeFile(path.join(output,file),bytes);record.resourceResponses.push({url:safeUrl(response.url()),type,status:response.status(),path:file,sha256:sha256(bytes),bytes:bytes.length});}catch(error){record.resourceResponses.push({url:safeUrl(response.url()),type,status:response.status(),error:error.message});}})());});
      try {
        const began = performance.now();
        await page.goto(item.url, { waitUntil: 'load', timeout: item.timeoutMs || 30000 });
        record.cell_key=item.cell_key || JSON.stringify([item.route_id || item.name,viewport.width,item.state_id || 'default']);
        record.mode=item.mode || 'static';
        record.action_trace = await actions(page,item.state?.actions || []);
        if(item.state?.waitMs) await page.waitForTimeout(Math.min(item.state.waitMs,10000));
        const scrollSweep = item.scrollSweep ?? config.scrollSweep ?? false;
        if (scrollSweep)record.action_trace.push(...await scrollThroughPage(page));
        record.source.finalUrl = validateFinalUrl(page.url(), allowlist, item.url);
        const target = page.locator(item.selector).first();
        if(!item.fullPage && !item.captureViewport) await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        enforceBounds(box, item.bounds || config.bounds);
        const imageReadyTimeoutMs = item.imageReadyTimeoutMs ?? config.imageReadyTimeoutMs ?? 10000;
        record.imageReadiness = await waitForTargetImages(target, imageReadyTimeoutMs);
        if (record.imageReadiness.failed.length || record.imageReadiness.timedOut.length) {
          throw new Error(`image readiness rejected: ${record.imageReadiness.failed.length} failed, ${record.imageReadiness.timedOut.length} timed out`);
        }
        const pageMetrics = await page.evaluate(async () => {
          let fontsReady = false;
          try { await document.fonts?.ready; fontsReady = document.fonts?.status === 'loaded'; } catch { /* unavailable */ }
          const fontErrors = [...(document.fonts || [])].filter((face) => face.status === 'error').map((face) => face.family);
          return { title: document.title, viewport: { width: innerWidth, height: innerHeight }, clientWidth: document.documentElement.clientWidth, devicePixelRatio, scrollY, documentHeight: document.documentElement.scrollHeight, fontsReady, fontErrors };
        });
        if (!pageMetrics.title.trim()) throw new Error('blank title rejected');
        if (!pageMetrics.fontsReady || pageMetrics.fontErrors.length) throw new Error(`invalid fonts rejected: ${pageMetrics.fontErrors.join(', ') || 'font loading incomplete'}`);
        record.environment = {...pageMetrics,browser:browser.version(),reducedMotion:item.reducedMotion || 'no-preference'};
        record.scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
        const expectedScroll=item.state?.expectedScroll || (scrollSweep?{x:0,y:0}:null);
        if(expectedScroll&&(record.scroll.x!==expectedScroll.x||record.scroll.y!==expectedScroll.y))throw Error('requested versus actual scroll state mismatch');
        record.publicState=await page.evaluate(()=>({loggedOut:!document.querySelector('#wpadminbar,[data-authenticated="true"]')}));
        if(!record.publicState.loggedOut) throw Error('authenticated public reference rejected');
        if(item.state?.actions?.some(a=>a.action==='diagnostic_font_size'))record.diagnosticDefect=true;
        const roles=item.roles || [{section_id:'document',role_id:'document',selector:item.selector}];
        const observations=await observe(page,roles,imageReadyTimeoutMs);
        observations.forms=await observeForms(page,item.formObservations||[]);
        record.backgroundReadiness=observations.backgrounds;
        record.imageReadiness.cssBackgroundImages='verified-via-decode-observation';
        if(observations.backgrounds.some(b=>b.status!=='loaded'))throw Error('CSS background readiness rejected');
        const observationsPath=`${item.name}.observations.json`;
        const observationsBytes=JSON.stringify(observations,null,2)+'\n';
        await writeFile(path.join(output,observationsPath),observationsBytes);
        record.observations={path:observationsPath,sha256:sha256(observationsBytes)};
        record.rootBox = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
        record.timing.beforeCaptureMs = Math.round(performance.now() - began);
        await page.addScriptTag({ content: captureJs });
        const result = await target.evaluate(async (el) => window.__domCapture.capture(el, { id: 'dce' }));
        record.timing.captureMs = Math.round(performance.now() - began - record.timing.beforeCaptureMs);
        record.warnings = result.warnings || [];
        for (const image of record.imageReadiness.notRequestedDetail) {
          record.warnings.push(`image readiness: not-requested, ${image.reason} — ${image.url}`);
        }
        const snapshot = await page.evaluate(redactInPage, result.page);
        const snapshotPath = `${item.name}.snapshot.html`;
        await writeFile(path.join(output, snapshotPath), snapshot);
        record.snapshot = { path: snapshotPath, sha256: sha256(snapshot) };
        record.assets = assetInventory(snapshot);
        const sensitiveFilled=await page.evaluate(()=>[...document.querySelectorAll('input,textarea')].some(el=>el.value && /password|secret|token|email|phone/i.test([el.type,el.name,el.id].join(' '))));
        if(sensitiveFilled)throw Error('sensitive filled controls cannot be compared without an explicit exception');
        record.masks=[];
        if(record.mode==='static' && item.staticPhaseMs!==undefined)throw Error('global static DOM freeze prohibited; use named staticAnimations');
        record.staticAnimations=[];
        for(const phase of item.staticAnimations || []){if(typeof phase.selector!=='string'||!Number.isFinite(phase.timeMs)||phase.timeMs<0||phase.timeMs>30000)throw Error('invalid named animation phase');const actual=await page.locator(phase.selector).evaluate((el,timeMs)=>{const animations=el.getAnimations();if(!animations.length)throw Error('named animation not observed');for(const a of animations){a.pause();a.currentTime=timeMs;}return animations.map(a=>({currentTime:a.currentTime,playState:a.playState}));},phase.timeMs);record.staticAnimations.push({...phase,actual});}
        if(record.mode==='static'&&item.videoPhase)record.videoPhase=await freezeVideoPhase(page,item.videoPhase);
        record.animation={mode:record.mode==='static'?'declared_static':'enabled',named_phases:record.staticAnimations};
        if(record.mode==='motion'){
          record.sequence=[];const beganMotion=performance.now();record.action_trace.push(...await actions(page,item.motion.triggerActions || []));
          for(const requested_ms of item.motion.sampleMs){await page.waitForTimeout(Math.max(0,requested_ms-(performance.now()-beganMotion)));const actual_ms=performance.now()-beganMotion;const bytes=await page.screenshot({animations:'allow'});const framePath=`${item.name}.phase-${requested_ms}.png`;await writeFile(path.join(output,framePath),bytes);const obs=await observe(page,roles,imageReadyTimeoutMs);const obsPath=`${item.name}.phase-${requested_ms}.json`;const ob=JSON.stringify(obs)+'\n';await writeFile(path.join(output,obsPath),ob);record.sequence.push({requested_ms,actual_ms,observation_ms:performance.now()-beganMotion,image:{path:framePath,sha256:sha256(bytes)},observations:{path:obsPath,sha256:sha256(ob)}});}
        }
        const screenshotPath = `${item.name}.source.png`;
        // An element screenshot is clipped to the TARGET's own layout box, not
        // its visual paint bounds. A state action that opens an absolutely
        // positioned overlay (a mobile nav panel, a popover) grows what's
        // painted without growing the trigger's box — its parent's box model
        // is unaffected by an out-of-flow descendant, by spec — so the
        // element screenshot silently clips to the collapsed size and comes
        // back near-blank. `captureViewport` takes a plain viewport
        // screenshot instead, showing whatever is actually on screen after
        // state actions ran; the target locator is still used for the
        // presence/visibility/image-readiness checks above.
        const captureViewport = item.captureViewport ?? config.captureViewport ?? false;
        const screenshot = item.fullPage
          ? await page.screenshot({fullPage:true, animations:'allow'})
          : captureViewport ? await page.screenshot({animations:'allow'}) : await target.screenshot({animations:'allow'});
        const finalScroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
        if(finalScroll.x!==record.scroll.x||finalScroll.y!==record.scroll.y)throw Error('scroll changed during screenshot readiness');
        record.captureKind=item.fullPage?'full_document':captureViewport?'viewport':'element';
        await writeFile(path.join(output, screenshotPath), screenshot);
        record.screenshot = { path: screenshotPath, sha256: sha256(screenshot) };
        await Promise.all(resourceTasks);
        record.resourceResponses.sort((a,b)=>a.path?.localeCompare(b.path)||0);
        record.timing.totalMs = Math.round(performance.now() - began);
        await writeFile(path.join(output, `${item.name}.json`), JSON.stringify(record, null, 2) + '\n');
        console.log(`ok ${item.name}: ${record.rootBox.width}x${record.rootBox.height}, ${record.warnings.length} warning(s)`);
      } catch (error) {
        record.error = error.message;
        if(!/sensitive filled controls/.test(error.message))try{const bytes=await page.screenshot({fullPage:item.fullPage||false,animations:'allow'});const file=`${item.name}.invalid.png`;await writeFile(path.join(output,file),bytes);record.invalidScreenshot={path:file,sha256:sha256(bytes),validation:'invalid_capture'};}catch(screenshotError){record.invalidScreenshotError=screenshotError.message;}
        await Promise.all(resourceTasks);
        await writeFile(path.join(output, `${item.name}.json`), JSON.stringify(record, null, 2) + '\n');
        console.error(`failed ${item.name}: ${error.message}`);
      } finally { await context.close(); }
      manifest.captures.push(record);
    }
  } finally { await browser.close(); }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (manifest.captures.some((capture) => capture.error)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
