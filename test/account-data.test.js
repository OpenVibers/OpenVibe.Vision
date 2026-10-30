'use strict';
/**
 * ADR-033: Vision's part of an account export (answers, compare samples, UI checks) and of a deletion, applied
 * through /internal/events with a stand-in Network. A deletion erases the person's rows and leaves other people's.
 * A redelivery changes nothing; a bad signature and a proxied request are refused.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender, uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { TABLES } = require('../server/identity/account-data');
const { testDb } = require('./helpers/db');

const A = ids.newId('user');
const B = ids.newId('user');
const EXP = `exp_${ids.ulid()}`;
const DEL = `del_${ids.ulid()}`;
const SECRET = `fixture_${'account'.repeat(6)}`;
const WRONG = `fixture_${'mismatch'.repeat(6)}`;
const exportEvent = { event_id: `evt_${ids.ulid()}`, event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: `evt_${ids.ulid()}`, event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });
const IMAGE = { source: 'upload', sourceUrl: null, sha256: 'a'.repeat(64), mime: 'image/png', bytes: 100 };

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_vision', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    await check('every table that names a person is covered or exempted with a reason', async () => {
        const d = await testDb();
        try {
            const missing = await uncovered(d.db, {
                tables: TABLES,
                exempt: {account_data_events: 'the ledger of requests itself: which export and deletion vision applied'},
            });
            assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        } finally { await d.close(); }
    });

    const stub = await startNetworkStub();
    const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'vision', clientSecret: 'vision-secret' });
    const t = await boot({ env: { VISION_EVENTS_SECRET: SECRET }, accountSend: sender });
    try {
        const aAnswer = await t.ctx.store.saveAnswer({ subject: A, requester: `user:${A}`, task: 'ask', question: 'What is this?', image: IMAGE, text: 'A answer', answer: { engine: 'ai', model: 'm' }, model: 'm', provider: 'mock', route: 'default.chat', costUsd: 0.0004, latencyMs: 10 });
        const bAnswer = await t.ctx.store.saveAnswer({ subject: B, requester: `user:${B}`, task: 'ocr', image: IMAGE, text: 'B answer', answer: { engine: 'local' }, model: 'tesseract', provider: 'local', route: 'local.ocr' });
        const aCheck = await t.ctx.store.saveUiCheck({ subject: A, requester: `user:${A}`, source: 'html', viewport: { w: 390, h: 844 }, engine: 'static-html', findings: [{ kind: 'overflow' }], summary: { summary: 'one fault' } });
        const bCheck = await t.ctx.store.saveUiCheck({ subject: B, requester: `user:${B}`, source: 'url', url: 'https://openvibe.vision/', viewport: { w: 1280, h: 800 }, engine: 'static-html', findings: [], summary: {} });
        const aCompare = await t.ctx.store.saveCompare({ subject: A, requester: `user:${A}`, task: 'ask', image: IMAGE, question: 'compare', samples: [{ engine: 'local', model: 'tesseract', provider: 'local', route: 'local.ocr', ok: true, text: 'A text', costUsd: 0, ms: 4 }] });

        await check('an export carries only A\'s answers, compare samples and UI checks', async () => {
            const body = bodyOf(exportEvent);
            const res = await t.get('/internal/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'exported');
            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_vision');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['answers.json', 'compare.json', 'ui-checks.json']);
            const all = JSON.stringify(part.body);
            assert.ok(all.includes(aAnswer.id));
            assert.ok(all.includes(aCheck.id));
            assert.ok(all.includes(aCompare.answer.id));
            assert.ok(!all.includes(bAnswer.id));
            assert.ok(!all.includes(bCheck.id));
            assert.ok(!all.includes('B answer'));
            const answers = part.body.files.find((f) => f.name === 'answers.json').content;
            assert.ok(answers.length >= 2);
            assert.ok(answers.every((x) => x.subject === A));
        });

        await check('a deletion erases A\'s rows and confirms with counts; B and no one else is touched', async () => {
            const body = bodyOf(deleteEvent);
            const res = await t.get('/internal/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'erased');
            const db = t.ctx.s.db;
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM vision_answers WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM vision_ui_checks WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM vision_compare_samples WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM vision_answers WHERE subject = $1', [B])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM vision_ui_checks WHERE subject = $1', [B])), 1);
            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            assert.ok(confirmation.body.erased.vision_answers >= 1);
            assert.ok(confirmation.body.erased.vision_ui_checks >= 1);
            assert.ok(confirmation.body.erased.vision_compare_samples >= 1);
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));
        });

        await check('a redelivery changes nothing', async () => {
            const body = bodyOf(deleteEvent);
            const res = await t.get('/internal/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'unchanged');
        });

        await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
            const body = bodyOf(exportEvent);
            assert.strictEqual((await t.get('/internal/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, WRONG) } })).status, 401);
            assert.strictEqual((await t.get('/internal/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(body, SECRET) } })).status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
