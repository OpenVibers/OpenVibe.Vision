'use strict';
/**
 * Compare: the local reader is free, each AI hint is a separate run, the model/provider reported are AI's
 * provenance (not the requested hint when AI answers differently), and /benchmarks aggregates without subjects.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const user = t.network.addUser('ana');
    const png = await t.textImage('TOTAL 5.50');
    try {
        await check('a compare with two hints returns three engines in order with measured cost and latency', async () => {
            const r = await t.get('/api/v1/compare', { as: user, multipart: { fields: { question: 'Read and describe this.', models: ['mock:one', 'mock:two'] }, image: png } });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.deepStrictEqual(b.compare.map((x) => x.engine), ['local', 'ai', 'ai']);
            assert.strictEqual(b.compare[0].cost_usd, 0);
            assert.strictEqual(b.compare[1].requested_model, 'mock:one');
            assert.strictEqual(b.compare[2].requested_model, 'mock:two');
            assert.ok(b.compare[1].latency_ms >= 0);
            assert.ok(b.compare[1].cost_usd > 0);
            assert.strictEqual(b.answer.engine, 'compare');
            assert.strictEqual(b.answer.answer.samples.length, 3);
        });

        await check('without hints, the offered route models are read and used as hints', async () => {
            const r = await t.get('/api/v1/compare', { as: user, multipart: { fields: { question: 'Describe it.' }, image: png } });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.ok(b.compare.length >= 2);
            assert.ok(b.compare.some((x) => x.requested_model === 'mock:mock-vision-one'));
            assert.ok(b.compare.some((x) => x.requested_model === 'mock:mock-vision-two'));
            assert.ok(t.aiServer.requests.some((x) => x.path === '/api/v1/routes'));
        });

        await check('a failing AI run is recorded as a failed sample; the local answer still returns', async () => {
            t.aiServer.setFail(true);
            const r = await t.get('/api/v1/compare', { as: user, multipart: { fields: { models: ['mock:one'] }, image: png } });
            t.aiServer.setFail(false);
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.strictEqual(b.compare[0].ok, true);
            assert.strictEqual(b.compare[1].ok, false);
            assert.ok(b.compare[1].error_code);
            assert.match(b.answer.text, /TOTAL/);
        });

        await check('benchmarks aggregate by engine/model and never expose a subject or answer text', async () => {
            const b = await t.get('/api/v1/benchmarks?task=ask');
            assert.strictEqual(b.status, 200);
            assert.ok(b.json().benchmarks.length >= 2);
            assert.ok(b.json().benchmarks.every((x) => x.samples >= 1 && x.avg_latency_ms >= 0 && x.avg_cost_usd >= 0));
            assert.ok(!b.text.includes(user.subject));
            assert.ok(!b.text.includes('TOTAL 5.50'));
            assert.strictEqual((await t.get('/api/v1/benchmarks?task=nope')).status, 400);
        });
    } finally {
        await t.close();
    }
    done();
})();
