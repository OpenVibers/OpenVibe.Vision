'use strict';

/**
 * The events Vision publishes (server/events/publisher.js): the envelope lands in Vision's own outbox
 * (server/events/outbox.js) and the relay sends it from there.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { testDb } = require('./helpers/db');
const { createVisionOutbox } = require('../server/events/outbox');
const { createPublisher } = require('../server/events/publisher');

const principal = { kind: 'user', subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4' };
const req = (path, body) => ({ path, body, principal, ov: {} });
const quiet = { warn() {}, error() {}, log() {} };

(async () => {
    const testdb = await testDb();
    const db = testdb.db;
    const config = {
        drill: false, networkInternalUrl: 'https://network.example',
        oauth: { clientId: 'vision', clientSecret: 'test-secret' },
        events: { url: 'https://events.example', scope: 'events.event.publish', outboxIntervalMs: 50 },
    };
    // The relay is off in this test: the envelope is only written, never sent.
    const outbox = createVisionOutbox({ s: { db }, config, log: quiet, fetchImpl: async () => { throw new Error('the relay must not send here'); } });
    const publisher = createPublisher({ outbox, log: quiet });
    const lastEvent = async () => {
        const row = await db.maybe('SELECT envelope FROM event_outbox ORDER BY id DESC LIMIT 1');
        return row ? row.envelope : null;
    };

    try {
        await check('ready event carries provenance but no answer text or image', async () => {
            await publisher.result(req('/ask', { image: 'data:image/png;base64,AAAA' }), {
                answer: { id: 'vis_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4', text: 'A red bicycle.', model: 'model', provider: 'ai', route: 'routed', cost_usd: 0.01, latency_ms: 120 },
            });
            const env = await lastEvent();
            assert.ok(env, 'the event waits in the outbox');
            assert.strictEqual(env.event_type, 'vision.result.ready');
            assert.deepStrictEqual(env.subject, { type: 'user', id: principal.subject });
            assert.strictEqual(env.payload.task, 'ask');
            assert.strictEqual(env.payload.source, 'data');
            assert.ok(!JSON.stringify(env).includes('red bicycle'));
            assert.ok(!JSON.stringify(env).includes('AAAA'));
        });

        await check('watch event names only the owner-granted source and detected classes', async () => {
            await publisher.alert(req('/watch', { source_ref: 'cam:front-door' }), { answer: { detections: [{ class: 'animal', confidence: 0.92 }] } });
            const env = await lastEvent();
            assert.strictEqual(env.event_type, 'vision.alert');
            assert.strictEqual(env.payload.source_ref, 'cam:front-door');
            assert.deepStrictEqual(env.payload.classes, ['animal']);
            await publisher.alert(req('/watch', {}), { answer: { detections: [{ class: 'animal', confidence: 0.92 }] } });
            const after = await lastEvent();
            assert.strictEqual(after.payload.source_ref, 'cam:front-door', 'a request without a source ref publishes nothing');
        });

        await check('anonymous results create no subject event', async () => {
            const before = Number(await db.value('SELECT count(*) FROM event_outbox'));
            await publisher.result({ ...req('/ocr', {}), principal: { kind: 'anonymous' } }, { answer: { text: 'x' } });
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM event_outbox')), before);
        });

        await check('successful API results call the publisher with the authenticated owner', async () => {
            const calls = [];
            const t = await boot({ eventPublisher: {
                result: async (request, out) => calls.push({ path: request.path, subject: request.principal.subject, id: out.check && out.check.id }),
                alert: async () => {},
            } });
            try {
                // The drill mode of the test boot keeps the relay off.
                assert.strictEqual(t.ctx.eventOutbox.enabled, false, 'the drain is off in a drill');
                const user = t.network.addUser('event-owner');
                const r = await t.get('/api/v1/ui-check', { as: user, json: { html: '<p>hello</p>' } });
                assert.strictEqual(r.status, 201, r.text);
                assert.deepStrictEqual(calls, [{ path: '/ui-check', subject: user.subject, id: r.json().check.id }]);
                const mcp = await t.get('/mcp', { bearer: t.network.userToken(user), json: {
                    jsonrpc: '2.0', id: 1, method: 'tools/call',
                    params: { name: 'vision.check_ui', arguments: { html: '<p>hello</p>' } },
                } });
                assert.strictEqual(mcp.status, 200, mcp.text);
                assert.strictEqual(mcp.json().result.isError, false, mcp.text);
                assert.strictEqual(calls.length, 2);
                assert.strictEqual(calls[1].path, '/ui-check');
                assert.strictEqual(calls[1].subject, user.subject);
            } finally { await t.close(); }
        });
    } finally {
        await testdb.close();
    }
    done();
})();
