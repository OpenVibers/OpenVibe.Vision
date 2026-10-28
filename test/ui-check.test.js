'use strict';
/**
 * The UI check: a planted overflow, cut-off line, low contrast, overlapping boxes and a layering fault are found in
 * static HTML; the same page is fetched from a URL; a screenshot gets the OCR-box and metadata pass; and the colour
 * maths is the WCAG ratio.
 */
const assert = require('assert');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');
const { checkHtml, contrastRatio, parseColor } = require('../server/vision/ui-check');

const PLANTED = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{background:#ffffff;color:#9a9a9a;font-size:16px}
.wide{width:1400px;height:40px;background:#eeeeee}
.cut{width:120px;overflow:hidden;white-space:nowrap}
.a,.b{position:absolute;top:20px;width:200px;height:100px;background:#dddddd}
.a{left:20px}.b{left:100px;top:60px;z-index:3}
.ghost{z-index:9}
.fixed{position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.2)}
</style></head><body><p class="ghost">Low contrast words here</p><div class="wide">wide</div><div class="cut">This is a long line that will be cut off</div><div class="a">A</div><div class="b">B</div><div class="fixed">overlay</div></body></html>`;

(async () => {
    await check('WCAG contrast maths', async () => {
        assert.ok(Math.abs(contrastRatio(parseColor('#000'), parseColor('#fff')) - 21) < 0.1);
        assert.ok(Math.abs(contrastRatio(parseColor('#777'), parseColor('#fff')) - 4.48) < 0.1);
        assert.ok(contrastRatio(parseColor('#999'), parseColor('#fff')) < 3);
    });

    await check('a planted overflow, cut-off, low contrast, overlap and layering fault are all found', async () => {
        const out = checkHtml(PLANTED, { viewport: { w: 1280, h: 800 } });
        assert.strictEqual(out.engine, 'static-html');
        for (const kind of ['overflow', 'cut_off', 'contrast', 'overlap', 'layering']) {
            assert.ok(out.findings.some((f) => f.kind === kind), `missing ${kind}: ${JSON.stringify(out.counts)}`);
        }
        assert.ok(out.findings.every((f) => f.severity && f.selector && f.detail));
        assert.match(out.summary, /UI faults? found/);
        assert.ok(out.warnings.some((w) => /JavaScript was not executed/.test(w)));
    });

    await check('a narrow viewport turns a 1400px card into an overflow; 1280px still reports it', async () => {
        const narrow = checkHtml(PLANTED, { viewport: { w: 390, h: 844 } });
        assert.ok(narrow.findings.some((f) => f.kind === 'overflow' && f.evidence.viewport === 390));
        const out = checkHtml('<div style="width:100vw;padding-left:20px;box-sizing:content-box">x</div>', { viewport: { w: 390, h: 800 } });
        assert.ok(out.findings.some((f) => f.kind === 'overflow'));
        const percent = checkHtml('<style>body{margin:0}.x{width:100%;padding-left:20px;box-sizing:content-box}</style><div class="x">x</div>', { viewport: { w: 390, h: 800 } });
        assert.ok(percent.findings.some((f) => f.kind === 'overflow'));
    });

    const t = await boot();
    try {
        await check('POST /ui-check returns saved findings with a stable vuc_ id', async () => {
            const r = await t.get('/api/v1/ui-check', { json: { html: PLANTED, viewport: { w: 390, h: 844 } } });
            assert.strictEqual(r.status, 201, r.text);
            const c = r.json().check;
            assert.match(c.id, /^vuc_/);
            assert.strictEqual(c.source, 'html');
            assert.strictEqual(c.engine, 'static-html');
            assert.strictEqual(c.viewport.w, 390);
            assert.ok(c.findings.length >= 4);
            const saved = await t.ctx.store.uiCheckById(c.id);
            assert.strictEqual(saved.findings.length, c.findings.length);
        });

        await check('a URL is fetched and checked locally', async () => {
            const r = await t.get('/api/v1/ui-check', { json: { url: `${t.pages.url}/page`, viewport: { w: 390, h: 844 } } });
            assert.strictEqual(r.status, 201, r.text);
            const c = r.json().check;
            assert.strictEqual(c.source, 'url');
            assert.match(c.url, /\/page$/);
            assert.ok(c.summary);
        });

        await check('a screenshot gets the local OCR-box and pixel pass, and says what it cannot see', async () => {
            const png = await sharp({ create: { width: 640, height: 220, channels: 4, background: '#ffffff' } }).png().toBuffer();
            const r = await t.get('/api/v1/ui-check', { multipart: { image: png } });
            assert.strictEqual(r.status, 201, r.text);
            const c = r.json().check;
            assert.strictEqual(c.engine, 'screenshot');
            assert.strictEqual(c.source, 'screenshot');
            assert.strictEqual(c.viewport.w, 640);
            assert.ok(c.summary.warnings.some((w) => /cannot show CSS layering/.test(w)));
            assert.ok(Array.isArray(c.findings));
        });

        await check('the API refuses an empty UI check and an oversized HTML body', async () => {
            const empty = await t.get('/api/v1/ui-check', { json: {} });
            assert.strictEqual(empty.status, 400);
            assert.strictEqual(empty.json().code, 'vision.invalid');
            const big = 'x'.repeat((t.config.ui.maxHtmlBytes || 1024 * 1024) + 10);
            const tooBig = await t.get('/api/v1/ui-check', { json: { html: big } });
            assert.ok([413, 400].includes(tooBig.status), String(tooBig.status));
        });
    } finally {
        await t.close();
    }
    done();
})();
