#!/usr/bin/env node
'use strict';

/**
 * The v1 proof, offline: render a receipt, read it with the local Tesseract engine, and check a page with a
 * planted overflow and low contrast. No database, no network, no model. A model call is deliberately not made:
 * the first proof is that the cheap local path and the UI check produce a usable artifact on their own.
 *
 *   node scripts/proof.js          human-readable
 *   node scripts/proof.js --json   one JSON document
 */
const sharp = require('sharp');
const { load } = require('../server/config');
const { createOcr } = require('../server/vision/ocr');
const { checkHtml } = require('../server/vision/ui-check');

function receipt() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="28" y="62" font-family="DejaVu Sans Mono" font-size="34" fill="#111111">OPENVIBE MARKET</text>
<text x="28" y="120" font-family="DejaVu Sans Mono" font-size="26" fill="#111111">2026-10-28 14:02</text>
<text x="28" y="176" font-family="DejaVu Sans Mono" font-size="28" fill="#111111">Oat milk          3.40</text>
<text x="28" y="222" font-family="DejaVu Sans Mono" font-size="28" fill="#111111">Bread             2.10</text>
<text x="28" y="294" font-family="DejaVu Sans Mono" font-size="34" fill="#111111">TOTAL             5.50</text>
</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

const PLANTED = `<!doctype html><html><head><style>
body{background:#fff;color:#9a9a9a;font-size:16px}
.wide{width:1400px;height:40px;background:#eee}
.cut{width:120px;overflow:hidden;white-space:nowrap}
</style></head><body><p>Low contrast words here</p><div class="wide">wide</div><div class="cut">This line will be cut off</div></body></html>`;

(async () => {
    const config = load({ NODE_ENV: 'development', VISION_TESSERACT: process.env.VISION_TESSERACT || 'tesseract' });
    const ocr = createOcr({ config });
    const image = await receipt();
    const read = await ocr.recognize(image);
    const ui = checkHtml(PLANTED, { viewport: { w: 390, h: 844 } });
    const out = {
        okay: Boolean(read.ok && /TOTAL\s+5\.50/.test(read.text || '')) && ui.counts.overflow >= 1 && ui.counts.contrast >= 1 && ui.counts.cut_off >= 1,
        ocr: { engine: 'tesseract', text: read.text || null, confidence: read.confidence == null ? null : read.confidence, ms: read.ms == null ? null : read.ms, cost_usd: 0, error: read.ok ? null : read.code },
        ui: { engine: ui.engine, viewport: ui.viewport, counts: ui.counts, summary: ui.summary, findings: ui.findings },
        model_calls: 0,
    };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
        console.log('OpenVibe.Vision v1 proof (offline)');
        console.log(`  local OCR: ${read.ok ? 'ok' : read.code} · ${read.ms} ms · confidence ${read.confidence}`);
        console.log(`  text: ${JSON.stringify(read.text || '')}`);
        console.log(`  UI check: ${ui.summary}`);
        for (const f of ui.findings) console.log(`    - ${f.kind} (${f.severity}) ${f.selector}: ${f.detail}`);
        console.log(`  model calls: 0`);
    }
    if (!out.okay) process.exitCode = 1;
})().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
