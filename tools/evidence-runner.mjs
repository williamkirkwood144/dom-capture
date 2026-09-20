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

const here = path.dirname(fileURLToPath(import.meta.url));
const REDACTED = '[REDACTED]';
const SENSITIVE = /pass(?:word)?|secret|token|auth|api[-_]?key|card|cc-|cvv|ssn|social|email|e-mail|phone|mobile/i;
export const MANIFEST_VERSION = 1;

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
    for (const action of capture.state?.actions || []) {
      if (!['click', 'hover', 'focus'].includes(action.action) || typeof action.selector !== 'string') throw new Error(`captures[${index}] has an invalid state action`);
    }
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
  return {
    total: images.length,
    loaded: images.filter((image) => image.status === 'loaded').length,
    notRequested: images.filter((image) => image.status === 'not-requested').length,
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
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const record = { name: item.name, source: { url: safeUrl(item.url), path: new URL(item.url).pathname }, selector: item.selector, state: item.state || {}, warnings: [], timing: {} };
      try {
        const began = performance.now();
        await page.goto(item.url, { waitUntil: 'load', timeout: item.timeoutMs || 30000 });
        await applyState(page, item.state);
        record.source.finalUrl = validateFinalUrl(page.url(), allowlist, item.url);
        const target = page.locator(item.selector).first();
        await target.scrollIntoViewIfNeeded();
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
        record.environment = pageMetrics;
        record.rootBox = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
        record.timing.beforeCaptureMs = Math.round(performance.now() - began);
        await page.addScriptTag({ content: captureJs });
        const result = await target.evaluate(async (el) => window.__domCapture.capture(el, { id: 'dce' }));
        record.timing.captureMs = Math.round(performance.now() - began - record.timing.beforeCaptureMs);
        record.warnings = result.warnings || [];
        const snapshot = await page.evaluate(redactInPage, result.page);
        const snapshotPath = `${item.name}.snapshot.html`;
        await writeFile(path.join(output, snapshotPath), snapshot);
        record.snapshot = { path: snapshotPath, sha256: sha256(snapshot) };
        record.assets = assetInventory(snapshot);
        await maskLiveSensitiveControls(page);
        const screenshotPath = `${item.name}.source.png`;
        const screenshot = await target.screenshot({ animations: 'disabled' });
        await writeFile(path.join(output, screenshotPath), screenshot);
        record.screenshot = { path: screenshotPath, sha256: sha256(screenshot) };
        record.timing.totalMs = Math.round(performance.now() - began);
        await writeFile(path.join(output, `${item.name}.json`), JSON.stringify(record, null, 2) + '\n');
        console.log(`ok ${item.name}: ${record.rootBox.width}x${record.rootBox.height}, ${record.warnings.length} warning(s)`);
      } catch (error) {
        record.error = error.message;
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
