'use strict';

/**
 * Vision's event outbox: the events Vision publishes to OpenVibe.Events wait in `event_outbox`
 * (migrations/0004_event_outbox.sql) until Events takes them. A publish that fails because Events is down or
 * the network blipped is not lost: the row stays and the relay sends it later, with backoff.
 *
 * openvibe-sdk/events' createServiceOutbox (openvibe-sdk 0.72.0) is the helper nine services already use
 * (Trade, News, Host, Codes, Blog, Deals, Coupons, VIP, Tips). It writes the envelope with its own `event_id`
 * — the idempotency key Events dedupes on — and the relay publishes the due rows with Vision's service token
 * (events.event.publish, audience openvibe.events).
 *
 * Delivery is at least once: a crash between the publish and the row being marked sent republishes the same
 * event_id, and Events answers that as a duplicate. A permanent refusal (a 4xx other than 401/408/409/425/429)
 * marks the row rejected and never retries it; anything else is retried with backoff.
 *
 * The relay is off in a drill (VISION_DRILL=1): a drill publishes nothing and writes no row. Without the events
 * URL or the OAuth client secret the relay is off too, and Vision publishes no event at all.
 */
const contracts = require('openvibe-contracts');
const { createServiceOutbox } = require('openvibe-sdk/events');

/** The event types Vision publishes (contracts 0.240.0). */
const EVENT_TYPES = ['vision.result.ready', 'vision.alert'];

function createVisionOutbox({ s, config, log = console, fetchImpl = null }) {
    const drill = Boolean(config.drill);
    const out = createServiceOutbox({
        db: s.db,
        source: 'vision',
        eventsUrl: config.events.url || null,
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.outboxIntervalMs,
        log,
        eventTypes: EVENT_TYPES,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        validate: (env) => {
            const envelope = contracts.validate('events.event-envelope@1', env);
            if (!envelope.valid) return envelope;
            return contracts.validate(`${env.event_type}@${env.version}`, env.payload);
        },
    });
    // The SDK's own switch (the events URL and the client secret are set); a drill turns the relay off on top.
    const enabled = Boolean(out.enabled) && !drill;

    return {
        EVENT_TYPES,
        /** Whether the relay may publish. False in a drill and without the events URL or the client secret. */
        enabled,
        /** The SDK relay itself (flush, pending, rejected, prune): the drain a test drives by hand. */
        outbox: out.outbox,
        /**
         * Write one envelope into the outbox. The row is durable before the caller answers, and the relay takes
         * it from there: publishing is never on the request's critical path.
         *
         * Nothing is written when the relay could not publish anyway (a drill, or Events not configured): Vision
         * publishes no event at all then, exactly as it did before the outbox.
         */
        async emit(envelope, opts = {}) {
            if (!enabled) return null;
            const env = await out.emit(envelope, opts);
            // Wake the relay now: a queued event does not wait for the next tick.
            if (enabled) Promise.resolve(out.kick()).catch(() => {});
            return env;
        },
        /** Start the relay (the background drain): due rows go out, a failure backs off. */
        start() { if (enabled) out.start(); },
        stop: () => out.stop(),
        /** Wake the relay now (a queued event does not wait for the next tick). */
        async kick() { if (enabled) await out.kick(); },
        async status() {
            const status = await out.status();
            return { ...status, enabled };
        },
    };
}

module.exports = { createVisionOutbox, EVENT_TYPES };
