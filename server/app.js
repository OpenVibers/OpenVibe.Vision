'use strict';

/**
 * OpenVibe.Vision — Express app factory; server/index.js listens, tests build their own instance with a temp
 * database, a mock Network and a mock OpenVibe.AI.
 *
 *   /, /ask, /ocr, /compare, /ui-check, /a/:id, /ui/:id, /people, /people/privacy, /developers   the pages (http/pages.js)
 *   /api/v1/*                                                          the API (http/api.js, http/faces-api.js)
 *   /auth/*                                                            Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics                    (loopback only)
 *   /internal/events                                                   account export/deletion (loopback only)
 *
 * Every model call goes through OpenVibe.AI; the local OCR engine, the UI check and the local face models run on this
 * host. No provider key, no paid provider, and no general answer stores image bytes. Only the opt-in face library
 * keeps encrypted uploads.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const { createApi } = require('./http/api');
const { createFaceApi } = require('./http/faces-api');
const { mcpRouter } = require('./http/mcp');
const { createPageRoutes } = require('./http/pages');
const { createServiceReadiness } = require('./observability');
const { assetVersion, send } = require('./render/layout');
const { raw } = require('./render/html');

const accountDataLib = require('./identity/account-data');
const { createStore } = require('./store');
const { createOcr } = require('./vision/ocr');
const { createAi } = require('./vision/ai');
const { createVision } = require('./vision/service');
const { createFacesModel } = require('./vision/faces-model');
const { createFaces } = require('./vision/faces');
const { createFaceLibraries } = require('./vision/face-libraries');
const { createConsentRegistry } = require('./vision/consent-registry');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { createPublisher } = require('./events/publisher');
const { createVisionOutbox } = require('./events/outbox');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

/**
 * opts: config, store, now (clock), fetchImpl (Network, AI and public URLs), log, valkey, accountSend (a
 * stand-in for Network's internal routes; tests only), telemetrySink.
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: s.now, log });
    const principal = createPrincipal({ config, keys });

    const store = createStore(s);
    const ocr = opts.ocr || createOcr({ config, log });
    const ai = opts.ai || createAi({ config, fetchImpl, log });
    const vision = createVision({ config, s, ocr, ai, store, log });
    const facesModel = opts.facesModel || createFacesModel({ dir: config.faces.modelsDir });
    const faces = createFaces({ s, config, model: facesModel });
    const consentRegistry = createConsentRegistry({ config, fetchImpl, log });
    const faceLibraries = createFaceLibraries({ s, config, model: facesModel, faces, network: consentRegistry, log });
    const models = require('./vision/local-models').createLocalModels({ config, clip: opts.clip, detector: opts.detector });
    const networkTools = require('./vision/network-tools').createNetworkTools({ s, ai, ocr, models, config, fetchImpl });

    // Account export and deletion (ADR-033). The sender posts to Network's internal routes with this service's own
    // client-credentials token; a test injects a stand-in through opts.accountSend.
    const accountData = accountDataLib.create({ db: s.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Vision cannot answer account events'); });

    // Vision's own event outbox (server/events/outbox.js): the events Vision publishes wait in event_outbox
    // until OpenVibe.Events takes them, so a failed publish is not lost. The relay starts in server/index.js.
    const eventOutbox = opts.eventOutbox || createVisionOutbox({ s, config, log, fetchImpl });
    const eventPublisher = opts.eventPublisher || createPublisher({ outbox: eventOutbox, log });
    const ctx = { config, s, keys, sso, principal, store, ocr, ai, vision, faces, faceLibraries, consentRegistry, models, networkTools, accountData, accountSend, eventOutbox, eventPublisher, log, fetchImpl };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'vision', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'vision', release: release.release });
    app.locals.metrics = metrics.registry;
    ctx.telemetry = createHttpTelemetry({ service: 'vision', sink: opts.telemetrySink || createPgTelemetrySink({ db: s.db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    app.use(ctx.telemetry.middleware());
    app.locals.ctx = ctx;

    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'blob:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-vision', name: 'OpenVibe.Vision', version: VERSION }));
    release.mount(app, { registry: metrics.registry });
    const readiness = createServiceReadiness({ s, config, valkey, ai, ocr, faces, models, sso });
    app.get('/api/ready', readiness.handler);

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'vision', service: 'vision', host: 'openvibe.vision', name: 'OpenVibe.Vision', profile: 'ugc' })); }

    // ── OpenVibe.Events → this service (loopback only) ──────
    // Account export/deletion; the consumer reads the raw body itself, so it is mounted before any body parser.
    // nginx answers 404 for /internal/.
    app.use('/internal/events', accountData.consumer({
        secrets: config.events.secrets,
        send: accountSend,
        now: s.now,
        onEvent: async (ev) => `ignored:${ev.event_type}`,
    }));

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use(mcpRouter(ctx));
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.VISION_API_RATE_LIMIT_PER_MIN) || 120, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    app.use('/api/v1/faces', createFaceApi(ctx));
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.VISION_RATE_LIMIT_PER_MIN) || 180, standardHeaders: true, legacyHeaders: false }));
    app.use(createPageRoutes(ctx));
    app.use((req, res) => send(res, 404, {
        viewer: req.viewer, config, path: req.originalUrl, title: 'Not found',
        body: raw(require('./views').notFound()),
    }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[OpenVibe.Vision]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That request was too large.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
