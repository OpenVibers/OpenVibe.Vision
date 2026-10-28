'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { parseReceipt } = require('../server/vision/network-tools');
(async () => {
    const clip = { async image() { return [1, 0]; }, async text(q) { return /bike|goal/.test(q) ? [1, 0] : [0, 1]; } };
    const detector = { async detect() { return [{ label: 'cat', score: 0.92, box: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 } }]; } };
    const ocr = { async recognize() { return { ok: true, text: 'MARKET\nOat milk 3.40\nBread 2.10\nTOTAL 5.50', confidence: 91 }; }, async available() { return 'fake-tesseract'; } };
    const t = await boot({ clip, detector, ocr });
    const owner = t.network.addUser('owner');
    const other = t.network.addUser('other');
    const png = await t.textImage('MARKET\nOat milk 3.40\nBread 2.10\nTOTAL 5.50');
    const image = `data:image/png;base64,${png.toString('base64')}`;
    try {
        await check('owner-scoped CLIP index and every find read', async () => {
            const indexed = await t.get('/api/v1/index', { as: owner, json: { item_id: 'photo-1', image } });
            assert.strictEqual(indexed.status, 201, indexed.text);
            assert.strictEqual(indexed.json().answer.receipt.retention.includes('stored'), true);
            const mine = await t.get('/api/v1/find?q=bike', { as: owner });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.strictEqual(mine.json().answer.results[0].item_id, 'photo-1');
            assert.ok(mine.json().answer.receipt);
            const theirs = await t.get('/api/v1/find?q=bike', { as: other });
            assert.strictEqual(theirs.status, 200);
            assert.deepStrictEqual(theirs.json().answer.results, []);
            const svc = t.network.serviceToken({ sub: 'svc:media', cap: ['vision.find'] });
            assert.strictEqual((await t.get('/api/v1/find?q=bike', { bearer: svc })).status, 403);
            const byImage = await t.get('/api/v1/find', { as: owner, json: { image } });
            assert.strictEqual(byImage.json().answer.results[0].item_id, 'photo-1');
        });
        await check('alt text sends noLooks and cleans the answer', async () => {
            t.aiServer.setText('A shirtless man holds a bicycle.');
            const r = await t.get('/api/v1/alt', { as: owner, json: { image } });
            assert.strictEqual(r.status, 201, r.text);
            assert.ok(!/shirtless/.test(r.json().answer.alt_text));
            assert.ok(r.json().answer.editable);
            assert.strictEqual(r.json().answer.receipt.engine, 'routed');
            const sent = t.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').at(-1);
            assert.match(JSON.stringify(sent.body), /Never describe a person's body/);
        });
        await check('receipt parser and local route return structured lines and receipt', async () => {
            assert.deepStrictEqual(parseReceipt('MARKET\n2 x Apples 3.40\nTOTAL 3.40').items[0], { name: 'Apples', qty: 2, price: 3.4 });
            const r = await t.get('/api/v1/receipt', { as: owner, json: { image } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().answer.receipt.engine, 'local');
            assert.ok(r.json().answer.items.length);
        });
        await check('watch and moments include detections and receipts; service without owner fails', async () => {
            const w = await t.get('/api/v1/watch', { as: owner, json: { image, classes: ['cat'] } });
            assert.strictEqual(w.status, 201, w.text);
            assert.strictEqual(w.json().answer.detections[0].class, 'cat');
            assert.ok(w.json().answer.receipt);
            const m = await t.get('/api/v1/moments', { as: owner, json: { frames: [{ timestamp_ms: 1000, image }], prompts: ['a goal'] } });
            assert.strictEqual(m.status, 201, m.text);
            assert.ok(m.json().answer.receipt);
            assert.strictEqual(m.json().answer.candidate_moments[0].timestamp_ms, 1000);
            const svc = t.network.serviceToken({ sub: 'svc:cam', cap: ['vision.watch'] });
            assert.strictEqual((await t.get('/api/v1/watch', { bearer: svc, json: { image, classes: ['cat'] } })).status, 403);
        });
        await check('product has embedding and receipt even if offer APIs are not configured', async () => {
            t.aiServer.setText('Blue bicycle');
            const r = await t.get('/api/v1/product', { as: owner, json: { image } });
            assert.strictEqual(r.status, 201, r.text);
            assert.deepStrictEqual(r.json().answer.embedding, [1, 0]);
            assert.ok(r.json().answer.receipt);
        });
        await check('missing weights degrade without a model download', async () => {
            const { createLocalModels } = require('../server/vision/local-models');
            const absent = createLocalModels({ config: { models: { dir: '/tmp/vision-models-absent' } } });
            assert.strictEqual(absent.clipReady(), false);
            await assert.rejects(absent.clip(), (e) => e.status === 503 && e.code === 'vision.clip_unavailable');
            const original = t.ctx.models.clip;
            t.ctx.models.clip = absent.clip;
            try {
                const r = await t.get('/api/v1/index', { as: owner, json: { item_id: 'unavailable', image } });
                assert.strictEqual(r.status, 503);
                assert.strictEqual(r.json().code, 'vision.clip_unavailable');
            } finally { t.ctx.models.clip = original; }
        });
        await check('plain tool pages render with vi classes', async () => {
            for (const path of ['/find', '/read', '/watch']) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, `${path}: ${r.text}`);
                assert.match(r.text, /class="vi-/);
            }
        });
    } finally { await t.close(); }
    done();
})();
