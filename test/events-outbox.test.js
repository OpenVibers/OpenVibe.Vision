'use strict';

/**
 * Vision's event outbox (server/events/outbox.js): the durable retry queue behind every event Vision publishes.
 *
 *   a failed publish is kept and sent on the next drain   Events is down: the row stays, the next drain sends it
 *   a successful one is removed                          a sent event leaves the pending queue and is pruned
 *   the drain stays off in a drill                       VISION_DRILL=1: nothing is published and no row is written
 *
 * Delivery is at least once and the event's own id is the idempotency key Events dedupes on.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { testDb } = require('./helpers/db');
const { createVisionOutbox } = require('../server/events/outbox');
const { createPublisher } = require('../server/events/publisher');

const USER = { kind: 'user', subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4' };
const RESULT_ID = 'vis_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4';

const quiet = { warn() {}, error() {}, log() {} };

function config(over = {}) {
    return {
        drill: false,
        networkInternalUrl: 'https://network.example',
        oauth: { clientId: 'vision', clientSecret: 'vision-secret' },
        events: { url: 'https://events.example', scope: 'events.event.publish', outboxIntervalMs: 50 },
        ...over,
    };
}

/** The token and the publish request; state.fail makes Events answer 503 (Events is down). */
function eventsFetch(state) {
    return async (url, options) => {
        const u = String(url);
        if (u.endsWith('/oauth/token')) return Response.json({ access_token: 'test-token', expires_in: 300 });
        if (u.endsWith('/api/v1/events')) {
            if (state.fail) return Response.json({ error: { code: 'events.unavailable', message: 'down' } }, { status: 503 });
            const body = JSON.parse(options.body);
            const headers = options.headers || {};
            const key = typeof headers.get === 'function' ? headers.get('idempotency-key') : headers['Idempotency-Key'];
            state.sent.push({ body, key });
            return Response.json({ event_id: body.event_id, cursor: 'cursor' });
        }
        throw new Error('unexpected URL: ' + u);
    };
}

const request = (path, body) => ({ path, body, principal: USER, ov: {} });
const answer = { answer: { id: RESULT_ID, text: 'A red bicycle.', model: 'model', provider: 'ai', route: 'routed', cost_usd: 0.01, latency_ms: 120 } };

(async () => {
    const testdb = await testDb();
    const db = testdb.db;
    try {
        await check('a failed publish is kept and sent on the next drain', async () => {
            await db.exec('DELETE FROM event_outbox');
            const state = { fail: true, sent: [] };
            const outbox = createVisionOutbox({ s: { db }, config: config(), log: quiet, fetchImpl: eventsFetch(state) });
            const publisher = createPublisher({ outbox, log: quiet });

            await publisher.result(request('/ask', { image: 'data:image/png;base64,AAAA' }), answer);

            // The event is durable before the answer went out: it waits in the table.
            const row = await db.maybe('SELECT event_id, envelope, sent_at FROM event_outbox ORDER BY id DESC LIMIT 1');
            assert.ok(row, 'the event waits in the outbox');
            assert.strictEqual(row.sent_at, null);
            assert.strictEqual(row.envelope.event_type, 'vision.result.ready');
            assert.strictEqual(row.envelope.source, 'vision');
            assert.ok(row.event_id, 'the event carries its own id');

            // The drain tries and Events is down: the row stays, with the failure recorded.
            await outbox.outbox.flush();
            const failed = await db.maybe('SELECT * FROM event_outbox WHERE event_id = $1', [row.event_id]);
            assert.ok(failed, 'a failed publish is kept');
            assert.strictEqual(failed.sent_at, null);
            assert.strictEqual(Number(failed.attempts), 1);
            assert.ok(failed.last_error, 'the failure is recorded on the row');
            assert.strictEqual(Number(await outbox.outbox.pending()), 1);

            // The next drain sends it: the same event id is the idempotency key Events dedupes on.
            state.fail = false;
            await db.exec('UPDATE event_outbox SET next_attempt_at = 0 WHERE event_id = $1', [row.event_id]);
            await outbox.outbox.flush();
            assert.strictEqual(state.sent.length, 1, 'the kept event goes out with the next drain');
            assert.strictEqual(state.sent[0].body.event_id, row.event_id);
            assert.strictEqual(state.sent[0].key, row.event_id, 'the idempotency key is the event id');
            const sent = await db.maybe('SELECT sent_at FROM event_outbox WHERE event_id = $1', [row.event_id]);
            assert.ok(sent.sent_at, 'the row is marked sent');
            assert.strictEqual(Number(await outbox.outbox.pending()), 0);
            await outbox.stop();
        });

        await check('a successful one is removed', async () => {
            await db.exec('DELETE FROM event_outbox');
            const state = { fail: false, sent: [] };
            const outbox = createVisionOutbox({ s: { db }, config: config(), log: quiet, fetchImpl: eventsFetch(state) });
            const publisher = createPublisher({ outbox, log: quiet });

            await publisher.result(request('/ask', {}), answer);
            await outbox.outbox.flush();
            assert.strictEqual(state.sent.length, 1);
            assert.strictEqual(Number(await outbox.outbox.pending()), 0, 'a sent event is no longer pending');

            // The relay prunes the sent rows once they are old enough (every 6 hours while it runs).
            await db.exec('UPDATE event_outbox SET sent_at = sent_at - 10000');
            await outbox.outbox.prune(0);
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM event_outbox')), 0, 'a sent event is removed');
            await outbox.stop();
        });

        await check('the drain stays off in a drill', async () => {
            await db.exec('DELETE FROM event_outbox');
            let calls = 0;
            const outbox = createVisionOutbox({
                s: { db }, config: config({ drill: true }), log: quiet,
                fetchImpl: async () => { calls++; return Response.json({}); },
            });
            const publisher = createPublisher({ outbox, log: quiet });

            await publisher.result(request('/ask', {}), answer);
            outbox.start();
            await outbox.outbox.flush();
            await outbox.stop();

            assert.strictEqual(calls, 0, 'a drill publishes nothing');
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM event_outbox')), 0, 'a drill writes no row');
            assert.strictEqual(outbox.enabled, false);
        });

        await check('without Events configured nothing is published and no row is written', async () => {
            await db.exec('DELETE FROM event_outbox');
            let calls = 0;
            const outbox = createVisionOutbox({
                s: { db }, config: config({ events: { url: '', scope: 'events.event.publish', outboxIntervalMs: 50 } }), log: quiet,
                fetchImpl: async () => { calls++; return Response.json({}); },
            });
            const publisher = createPublisher({ outbox, log: quiet });

            await publisher.result(request('/ask', {}), answer);
            outbox.start();
            await outbox.outbox.flush();
            await outbox.stop();

            assert.strictEqual(calls, 0, 'nothing is published');
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM event_outbox')), 0, 'no row is written');
            assert.strictEqual(outbox.enabled, false);
        });
    } finally {
        await testdb.close();
    }
    done();
})();
