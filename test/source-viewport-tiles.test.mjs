import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureViewportTiles, planViewportScreenshotTiles } from '../tools/evidence-runner.mjs';

assert.deepEqual(planViewportScreenshotTiles(2235, 900), [0, 720, 1335]);
assert.deepEqual(planViewportScreenshotTiles(900, 900), [0]);
assert.throws(() => planViewportScreenshotTiles(2235, 900, { maxTiles: 2 }), /maxTiles/);

async function fakePage(outputDir, failAt = 0) {
  let evalCount = 0;
  let shots = 0;
  const events = [];
  return {
    events,
    get shots() { return shots; },
    async evaluate(_fn, arg) {
      evalCount += 1;
      if (evalCount === 1) { events.push('dom-read'); return '<html><body>raw</body></html>'; }
      if (typeof arg === 'string') { events.push('sanitize'); return '<html><body>sanitized</body></html>'; }
      if (evalCount === 3) { events.push('layout'); return { documentHeight: 2235, viewportHeight: 900, viewportWidth: 390, scrollX: 0, scrollY: 0, fontStatus: 'loaded', fontsReady: true, fontErrors: [] }; }
      if (typeof arg === 'number') { events.push('scroll:'+arg); return { x:0, y:arg, documentHeight:2235, viewportHeight:900, viewportWidth:390 }; }
      return 2235;
    },
    async screenshot(options) {
      shots += 1; events.push('png:'+shots);
      assert.equal(options.fullPage, undefined, 'tiles must be viewport screenshots');
      assert.equal(options.animations, 'allow', 'tile capture must not freeze animations');
      assert.equal(options.timeout, 30000);
      const files = await readdir(outputDir);
      assert(files.some(name => name.endsWith('.snapshot.html')), 'sanitized DOM must be persisted before the first tile');
      if (shots === failAt) throw new Error('tile screenshot timeout after fonts loaded');
      return Buffer.from('tile-png-'+shots);
    },
  };
}

for (const failAt of [0, 2]) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'source-viewport-tiles-'));
  try {
    const page = await fakePage(outputDir, failAt);
    const record = {};
    const result = await captureViewportTiles(page, { outputDir, name:'property', record, timeoutMs:30000 });
    if (!failAt) {
      assert.equal(result.status, 'captured');
      assert.deepEqual(record.tileScreenshots.map(x => x.actualScroll.y), [0,720,1335]);
      assert.equal(record.tileCoverage.status, 'complete');
      assert.deepEqual(record.tileCoverage.gaps, []);
      assert.equal(record.tileCoverage.documentHeight, 2235);
      assert.equal(page.shots, 3);
      for (const tile of record.tileScreenshots) assert.equal((await readFile(path.join(outputDir,tile.path))).toString(), 'tile-png-'+tile.index);
    } else {
      assert.equal(result.status, 'failed');
      assert.equal(page.shots, 2, 'failure must stop after the first error with no retry');
      assert.equal(record.tileScreenshots.length, 1, 'only completed tiles may be listed');
      assert.equal(record.tileCoverage.status, 'incomplete');
      assert.match(record.screenshotFailure.error, /tile screenshot timeout/);
      assert.equal(record.screenshotFailure.fontStatus, 'loaded');
    }
  } finally { await rm(outputDir, { recursive:true, force:true }); }
}
console.log('viewport tile coverage tests passed');
