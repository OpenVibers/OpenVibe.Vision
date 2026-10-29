'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createPublisher } = require('../server/events/publisher');

(async () => {
    const sent = [];
    const config = {
        drill: false, networkInternalUrl: 'https://network.example',
        oauth: { clientId: 'vision', clientSecret: 'test-secret' },
        events: { url: 'https://events.example', scope: 'events.event.publish' },
    };
    const fetchImpl = async (url, options) => {
        if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'test-token', expires_in: 300 });
        if (String(url).endsWith('/api/v1/events')) {
            sent.push(JSON.parse(options.body));
            return Response.json({ event_id: sent.at(-1).event_id, cursor: 'cursor' });
        }
        throw new Error('unexpected URL');
    };
    const publisher = createPublisher({ config, fetchImpl, log: { warn() { throw new Error('event publish failed'); } } });
    const principal = { kind: 'user', subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4' };
    const req = (path, body) => ({ path, body, principal, ov: {} });

    await check('ready event carries provenance but no answer text or image', async () => {
        await publisher.result(req('/ask', { image: 'data:image/png;base64,AAAA' }), {
            answer: { id: 'vis_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4', text: 'A red bicycle.', model: 'model', provider: 'ai', route: 'routed', cost_usd: 0.01, latency_ms: 120 },
        });
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].event_type, 'vision.result.ready');
        assert.deepStrictEqual(sent[0].subject, { type: 'user', id: principal.subject });
        assert.strictEqual(sent[0].payload.task, 'ask');
        assert.strictEqual(sent[0].payload.source, 'data');
        assert.ok(!JSON.stringify(sent[0]).includes('red bicycle'));
        assert.ok(!JSON.stringify(sent[0]).includes('AAAA'));
    });

    await check('watch event names only the owner-granted source and detected classes', async () => {
        await publisher.alert(req('/watch', { source_ref: 'cam:front-door' }), { answer: { detections: [{ class: 'animal', confidence: 0.92 }] } });
        assert.strictEqual(sent[1].event_type, 'vision.alert');
        assert.strictEqual(sent[1].payload.source_ref, 'cam:front-door');
        assert.deepStrictEqual(sent[1].payload.classes, ['animal']);
        await publisher.alert(req('/watch', {}), { answer: { detections: [{ class: 'animal', confidence: 0.92 }] } });
        assert.strictEqual(sent.length, 2);
    });

    await check('anonymous results create no subject event', async () => {
        await publisher.result({ ...req('/ocr', {}), principal: { kind: 'anonymous' } }, { answer: { text: 'x' } });
        assert.strictEqual(sent.length, 2);
    });

    await check('successful API results call the publisher with the authenticated owner', async () => {
        const calls = [];
        const t = await boot({ eventPublisher: {
            result: async (request, out) => calls.push({ path: request.path, subject: request.principal.subject, id: out.check && out.check.id }),
            alert: async () => {},
        } });
        try {
            const user = t.network.addUser('event-owner');
            const r = await t.get('/api/v1/ui-check', { as: user, json: { html: '<p>hello</p>' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.deepStrictEqual(calls, [{ path: '/ui-check', subject: user.subject, id: r.json().check.id }]);
        } finally { await t.close(); }
    });
    done();
})();
