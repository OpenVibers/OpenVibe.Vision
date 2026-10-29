'use strict';

const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient } = require('openvibe-sdk/events');

const TASKS = Object.freeze({
    '/ask': 'ask', '/describe': 'describe', '/ocr': 'ocr', '/compare': 'compare', '/alt': 'alt',
    '/find': 'find', '/receipt': 'receipt', '/product': 'product', '/watch': 'watch',
    '/moments': 'moments', '/ui-check': 'ui_check',
});

function createPublisher({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    if (config.drill || !config.events.url || !config.oauth.clientSecret) return { result: async () => {}, alert: async () => {} };
    const tokenProvider = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, audience: 'openvibe.events', scope: config.events.scope, fetch: fetchImpl,
    });
    const client = createClient({ baseUrls: { events: config.events.url }, tokenProvider, fetch: fetchImpl, retries: 1 });
    const events = createEventsClient(client, { source: 'vision' });

    function subject(req) {
        const p = req.principal;
        if (p && p.kind === 'user') return { type: 'user', id: p.subject };
        if (p && p.kind === 'service') return { type: 'service', id: p.sub };
        return null;
    }
    async function publish(req, type, payload) {
        const ref = subject(req);
        if (!ref) return;
        try {
            await events.publish({ event_type: type, actor: ref, subject: ref, visibility: ref.type === 'user' ? 'subject' : 'internal', priority: 'important', payload }, { traceparent: req.ov && req.ov.traceparent });
        } catch (err) { log.warn('[OpenVibe.Vision] event publish failed:', String(err && err.message || err).slice(0, 180)); }
    }
    async function result(req, out) {
        const task = TASKS[req.path];
        if (!task || !out) return;
        const value = out.answer || out.check;
        if (!value) return;
        const receipt = value.receipt || {};
        await publish(req, 'vision.result.ready', {
            result_id: value.id || null, task,
            source: req.file ? 'upload' : req.body && req.body.image ? 'data' : req.body && (req.body.image_url || req.body.url) ? 'url' : req.body && req.body.html ? 'html' : 'none',
            model: value.model || receipt.model || null,
            provider: value.provider || null,
            route: value.route || receipt.engine || null,
            cost_usd: Number(value.cost_usd ?? receipt.cost_usd ?? 0),
            latency_ms: Math.max(0, Math.round(Number(value.latency_ms ?? receipt.ms ?? 0))),
            confidence: Number.isFinite(Number(receipt.confidence)) && receipt.confidence != null ? Number(receipt.confidence) : null,
            retention: String(receipt.retention || (value.id ? 'result stored for owner' : 'not stored')).slice(0, 200),
            consent_id: null, created_at: new Date().toISOString(),
        });
    }
    async function alert(req, out) {
        if (req.path !== '/watch' || !out || !out.answer || !Array.isArray(out.answer.detections) || !out.answer.detections.length) return;
        const ref = req.body && req.body.source_ref;
        if (typeof ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:/_-]{1,159}$/.test(ref)) return;
        const detections = out.answer.detections.slice(0, 20);
        await publish(req, 'vision.alert', {
            kind: 'object', source_ref: ref, classes: detections.map((d) => String(d.class).slice(0, 60)),
            confidence: Number.isFinite(Number(detections[0].confidence)) ? Number(detections[0].confidence) : null,
            detected_at: new Date().toISOString(),
        });
    }
    return { result, alert };
}

module.exports = { createPublisher };
