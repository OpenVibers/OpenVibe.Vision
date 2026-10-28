'use strict';
/**
 * The local reader: a rendered text image is read with confidence and boxes, a read question stops there, and the
 * AI fallback runs only when the local reader finds nothing. A missing engine is an honest 503.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { parseTsv } = require('../server/vision/ocr');

(async () => {
    await check('parseTsv keeps reading order, words and mean confidence', async () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t90\tHELLO',
            '5\t1\t1\t1\t1\t2\t60\t10\t70\t20\t80\tVISION',
            '5\t1\t1\t1\t2\t1\t10\t40\t50\t20\t70\tTOTAL',
            '5\t1\t1\t1\t2\t2\t70\t40\t30\t20\t60\t5.50',
        ].join('\n');
        const out = parseTsv(tsv);
        assert.strictEqual(out.text, 'HELLO VISION\nTOTAL 5.50');
        assert.strictEqual(out.words.length, 4);
        assert.strictEqual(out.words[0].text, 'HELLO');
        assert.ok(out.confidence > 70 && out.confidence < 80);
    });

    const t = await boot();
    try {
        await check('the local reader reads a rendered image with no AI call and zero cost', async () => {
            const png = await t.textImage('HELLO VISION');
            const r = await t.get('/api/v1/ocr', { multipart: { image: png } });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.match(b.text, /HELLO VISION/);
            assert.strictEqual(b.answer.engine, 'local');
            assert.strictEqual(b.model, 'tesseract');
            assert.strictEqual(Number(b.cost_usd), 0);
            assert.ok(b.answer.confidence >= 0);
            assert.ok(b.answer.words.some((w) => w.text === 'HELLO'));
        });

        await check('a blank image with fallback=1 asks AI only after the local pass found nothing', async () => {
            const blank = await t.textImage('');
            const before = t.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').length;
            const r = await t.get('/api/v1/ocr', { as: t.network.addUser('reader'), multipart: { fields: { fallback: '1' }, image: blank } });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.strictEqual(b.answer.engine, 'ai');
            assert.match(b.text, /HELLO VISION/);
            assert.ok(t.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').length > before);
        });
    } finally {
        await t.close();
    }

    const missing = await boot({ ocr: { recognize: async () => ({ ok: false, code: 'vision.ocr_unavailable', detail: 'the local OCR engine (tesseract) is not installed on this host' }), available: async () => null } });
    try {
        await check('a missing local engine answers 503, not a silent cloud call', async () => {
            const r = await missing.get('/api/v1/ocr', { json: { image: `data:image/png;base64,${(await missing.textImage('X')).toString('base64')}` } });
            assert.strictEqual(r.status, 503);
            assert.strictEqual(r.json().code, 'vision.ocr_unavailable');
            assert.strictEqual(missing.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').length, 0);
        });
    } finally {
        await missing.close();
    }
    done();
})();
