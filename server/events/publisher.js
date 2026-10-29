'use strict';

/**
 * Vision → OpenVibe.Events (contracts 0.240.0): the events Vision publishes.
 *
 *   vision.result.ready   a visual result is ready for its owner or caller (never the answer text, never an image)
 *   vision.alert          an owner-granted camera alert (a watched source saw something)
 *
 * The envelope goes into Vision's own outbox (server/events/outbox.js) and the relay sends it, so a publish
 * that fails because Events is down or the network blipped is not lost: the row waits in the table and goes out
 * with the next drain, the event's own id as the idempotency key. Publishing is never on the request's
 * critical path.
 */
const TASKS = Object.freeze({
    '/ask': 'ask', '/describe': 'describe', '/ocr': 'ocr', '/compare': 'compare', '/alt': 'alt',
    '/find': 'find', '/receipt': 'receipt', '/product': 'product', '/watch': 'watch',
    '/moments': 'moments', '/ui-check': 'ui_check',
});

/**
 * The publisher: result(req, out) and alert(req, out) write one envelope each into the outbox.
 * The outbox (Vision's own, server/events/outbox.js) owns the relay, the event id and the retry.
 */
function createPublisher({ outbox, log = console } = {}) {
    if (!outbox || typeof outbox.emit !== 'function') throw new TypeError('createPublisher: the Vision event outbox is required');

    function subject(req) {
        const p = req.principal;
        if (p && p.kind === 'user') return { type: 'user', id: p.subject };
        if (p && p.kind === 'service') return { type: 'service', id: p.sub };
        return null;
    }
    async function publish(req, type, payload) {
        const ref = subject(req);
        if (!ref) return null;
        try {
            return await outbox.emit(
                { event_type: type, actor: ref, subject: ref, visibility: ref.type === 'user' ? 'subject' : 'internal', priority: 'important', payload },
                { traceparent: req.ov && req.ov.traceparent },
            );
        } catch (err) {
            // The row could not be written (the database is unhappy, the envelope broke a contract): say so,
            // but never fail the person's request over an event.
            log.warn('[OpenVibe.Vision] event outbox write failed:', String((err && err.message) || err).slice(0, 180));
            return null;
        }
    }
    async function result(req, out) {
        const task = req.visionTask || TASKS[req.path];
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
