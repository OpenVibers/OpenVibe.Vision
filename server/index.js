'use strict';

/**
 * OpenVibe.Vision — process entry. `node server/index.js`
 * Listens on PORT (5130) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { startSubscriptions } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the JWKS refresher stops, telemetry closes,
 * the store closes and the Events subscriptions stop. Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.Vision', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [
            () => { for (const t of timers) clearInterval(t); },
            () => ctx.keys.client.stop(),
            async () => { clearInterval(ctx.telemetryTick); if (ctx.retention) await ctx.retention.stop(); if (ctx.telemetry) await ctx.telemetry.stop(); },
            () => clearInterval(ctx.faceRetentionTick),
            () => { if (ctx.eventOutbox) ctx.eventOutbox.stop(); },
            () => ctx.s.close(),
            ...extra,
        ],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
    // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
    const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
    const server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => {
        console.log(`[OpenVibe.Vision] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
        // Warm the Network signing key immediately: a service nobody has signed in to yet must not read degraded
        // only because the first JWKS fetch had not happened.
        ctx.keys.ensure().catch(() => {});
    });
    server.keepAliveTimeout = 65_000;
    ctx.retention = startTelemetryRetention({ db: ctx.s.db, log: ctx.log || console, olderThanDays: 14 });
    ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
    ctx.telemetryTick.unref();
    // At boot and daily, remove expired face data. Drills never run this job.
    if (!config.drill) {
        ctx.faceRetentionTick = setInterval(() => { ctx.faces.retention().catch((err) => console.error('[OpenVibe.Vision] face retention:', err.message)); }, 24 * 60 * 60_000);
        ctx.faceRetentionTick.unref();
        ctx.faces.retention().catch((err) => console.error('[OpenVibe.Vision] face retention:', err.message));
    }
    ctx.keys.client.start();

    // The event relay: Vision's own outbox → OpenVibe.Events. The rows wait in event_outbox until the drain
    // sends them, with backoff after a failure. Off in a drill (a drill publishes nothing) and without the
    // events URL or the OAuth client secret (the rows wait for the next boot).
    ctx.eventOutbox.start();

    // The two account topics (export_requested, deleted) at OpenVibe.Events: idempotent; off without the URL, the
    // delivery secret and the client secret. The consumer itself is mounted in server/app.js.
    const subs = config.drill ? null : startSubscriptions({
        eventsUrl: config.events.url,
        endpoint: config.events.endpoint || `http://127.0.0.1:${config.port}/internal/events`,
        secret: config.events.secrets[0] || '',
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        log: ctx.log || console,
    });
    const extra = [() => { if (subs) subs.stop(); }];
    createLifecycle({ server, ctx, extra });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Vision] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
