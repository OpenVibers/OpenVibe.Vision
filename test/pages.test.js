'use strict';
/**
 * Server-rendered pages: the home, ask, OCR, compare, the UI check, one saved answer and one saved UI check, the
 * developers page, 404, cache headers, and the content-hashed assets. Public pages are public, max-age=60; a page
 * drawn for a signed-in person is private, no-store.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { assetVersion } = require('../server/render/layout');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

function jsonLd(html) {
    return [...String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}
const PLANTED = '<style>body{background:#fff;color:#999}.wide{width:1600px}</style><div class="wide">wide</div><p>low contrast</p>';

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const mod = t.network.addUser('mod', { role: 'global_mod' });
    const png = await t.textImage('HELLO VISION');
    try {
        await check('home: semantic, the room, the try section, public cache with Vary: Cookie', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
            assert.strictEqual(r.headers.get('vary'), 'Cookie');
            for (const marker of ['id="vi-home"', 'id="vi-try"', 'class="sc-room-scenes"', '<noscript><nav', '<footer id="ov-footer"', '<main id="main"', '/ask', '/ocr', '/compare', '/ui-check']) assert.ok(r.text.includes(marker), marker);
            const types = jsonLd(r.text).map((x) => x['@type']);
            assert.ok(types.includes('WebSite'), types.join(','));
            assert.ok(types.includes('WebApplication'), types.join(','));
        });

        await check('a page drawn for a signed-in person is private, no-store', async () => {
            const r = await t.get('/', { as: alice });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            assert.strictEqual(r.headers.get('vary'), 'Cookie');
        });

        await check('POST /ask saves an answer and redirects to its private page', async () => {
            const r = await t.get('/ask', { as: alice, multipart: { fields: { task: 'describe', question: 'What is this?' }, image: png } });
            assert.strictEqual(r.status, 303, r.text);
            assert.match(r.headers.get('location'), /^\/a\/vis_/);
            const id = r.headers.get('location').split('/').pop();
            const page = await t.get(`/a/${id}`, { as: alice });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('id="vi-answer"'));
            assert.ok(page.text.includes('red bicycle'));
            assert.strictEqual((await t.get(`/a/${id}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/a/${id}`, { as: mod })).status, 200);
            assert.strictEqual((await t.get(`/a/${id}`)).status, 404);
        });

        await check('POST /ocr works without an account and renders the reading in the page', async () => {
            const r = await t.get('/ocr', { multipart: { image: png } });
            assert.strictEqual(r.status, 200, r.text);
            assert.ok(r.text.includes('id="vi-ocr-result"'));
            assert.ok(r.text.includes('HELLO VISION'));
            const saved = await t.get('/ocr', { as: alice, multipart: { image: png } });
            assert.strictEqual(saved.status, 303);
            assert.match(saved.headers.get('location'), /^\/a\/vis_/);
        });

        await check('/compare lists hints and a signed-in compare redirects to a saved answer', async () => {
            const form = await t.get('/compare', { as: alice });
            assert.strictEqual(form.status, 200);
            assert.ok(form.text.includes('id="vi-compare-form"'));
            assert.ok(form.text.includes('mock:mock-vision-one'));
            const r = await t.get('/compare', { as: alice, multipart: { fields: { question: 'Read it.', models: ['mock:one'] }, image: png } });
            assert.strictEqual(r.status, 303, r.text);
            assert.match(r.headers.get('location'), /^\/a\/vis_/);
        });

        await check('POST /ui-check works anonymously and saves for a signed-in person', async () => {
            const anon = await t.get('/ui-check', { multipart: { fields: { html: PLANTED, viewport_w: '390', viewport_h: '844' } } });
            assert.strictEqual(anon.status, 200, anon.text);
            assert.ok(anon.text.includes('id="vi-ui-result"'));
            assert.ok(anon.text.includes('vi-finding-overflow'));
            assert.ok(anon.text.includes('vi-finding-contrast'));
            const saved = await t.get('/ui-check', { as: alice, multipart: { fields: { html: PLANTED, viewport_w: '390', viewport_h: '844' } } });
            assert.strictEqual(saved.status, 303, saved.text);
            assert.match(saved.headers.get('location'), /^\/ui\/vuc_/);
            const id = saved.headers.get('location').split('/').pop();
            const page = await t.get(`/ui/${id}`, { as: alice });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('id="vi-check"'));
            assert.ok(page.text.includes('id="vi-findings"'));
            assert.strictEqual((await t.get(`/ui/${id}`, { as: bob })).status, 404);
        });

        await check('/developers names the API and the capabilities; the 404 is the Vision page', async () => {
            const dev = await t.get('/developers');
            assert.strictEqual(dev.status, 200);
            assert.strictEqual(dev.headers.get('cache-control'), 'public, max-age=60');
            assert.ok(dev.text.includes('id="vi-developers"'));
            assert.ok(dev.text.includes('vision.ui.check'));
            assert.ok(dev.text.includes('/api/v1/ui-check'));
            const nf = await t.get('/no/such/page');
            assert.strictEqual(nf.status, 404);
            assert.match(nf.headers.get('content-type'), /^text\/html/);
            assert.ok(nf.text.includes('id="vi-not-found"'));
        });

        await check('assets are content-hashed; robots and sitemap list the public pages', async () => {
            const v = assetVersion('css/vision.css');
            const hashed = await t.get(`/css/vision.css?v=${v}`);
            assert.strictEqual(hashed.status, 200);
            assert.strictEqual(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
            const wrong = await t.get('/css/vision.css?v=deadbeefdeadbeef');
            assert.strictEqual(wrong.status, 200);
            assert.strictEqual(wrong.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
            const robots = await t.get('/robots.txt');
            assert.match(robots.text, /Disallow: \/api\//);
            assert.match(robots.text, /Disallow: \/a\//);
            const map = await t.get('/sitemap.xml');
            assert.strictEqual(map.status, 200);
            assert.ok(map.text.includes('https://openvibe.vision/ui-check'));
            const llms = await t.get('/llms.txt');
            assert.strictEqual(llms.status, 200);
            assert.ok(llms.text.includes('OpenVibe.Vision'));
            assert.match(llms.text, /No face recognition/);
        });
    } finally {
        await t.close();
    }
    done();
})();
