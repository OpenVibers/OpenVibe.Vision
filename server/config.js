'use strict';

/**
 * OpenVibe.Vision configuration. Every value comes from the environment (production: /etc/openvibe/vision.env,
 * see .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const { modelsDir } = require('./paths');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5130);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.vision' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'vision',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        drill: env.VISION_DRILL === '1' || env.VISION_DRILL === 'true',
        limits: {
            minute: Math.max(1, int(env.VISION_LIMITS_MINUTE, 60)),
            hour: Math.max(1, int(env.VISION_LIMITS_HOUR, 600)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used.
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.VISION_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:vision:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        audience: env.VISION_AUDIENCE || 'openvibe.vision',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'vision',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service's account export/deletion route. The secret signs a delivery
        // (comma-separated for rotation, 32+ characters each); unset turns POST /internal/events off (503).
        events: {
            secrets: String(env.VISION_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.VISION_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.VISION_EVENTS_ENDPOINT || '',
            intervalMs: Math.max(500, int(env.VISION_EVENTS_INTERVAL_MS, 5000)),
            // The outbox relay: how often the drain looks for events that are due (the retry backoff is the
            // SDK outbox's own: 1s, 5s, 30s, 2 min, 10 min).
            outboxIntervalMs: Math.max(250, int(env.VISION_EVENTS_OUTBOX_INTERVAL_MS, 2000)),
            scope: env.VISION_EVENTS_SCOPE || 'events.event.publish',
        },

        // OpenVibe.AI: the model gateway. Vision never talks to a model provider directly and never holds a
        // provider key. Calls are first-party service-token runs (ai.run.create, namespace ai.*), so AI's own
        // routing, quotas, cache, provenance and cost accounting apply. With no client secret AI is off and the
        // local engines alone answer.
        ai: {
            url: trim(env.OV_AI_URL || env.OV_AI_INTERNAL_URL || 'https://ai.openvibe.services'),
            audience: env.VISION_AI_AUDIENCE || 'openvibe.ai',
            scope: env.VISION_AI_SCOPE || 'ai.run.create',
            namespace: env.VISION_AI_NAMESPACE || 'ai.*',
            models: String(env.VISION_AI_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6),
            timeoutMs: Math.max(5000, int(env.VISION_AI_TIMEOUT_MS, 45000)),
            waitMs: Math.max(1000, int(env.VISION_AI_WAIT_MS, 30000)),
            maxTokens: Math.min(2000, Math.max(64, int(env.VISION_AI_MAX_TOKENS, 700))),
            temperature: Math.min(1, Math.max(0, Number(env.VISION_AI_TEMPERATURE || 0.1))),
        },

        // The local OCR engine (Tesseract 5). OpenCV is the classical first step the plan names; Tesseract is the
        // local reader v1 ships. A missing binary is an honest 503, never a silent cloud fallback.
        ocr: {
            bin: env.VISION_TESSERACT || 'tesseract',
            lang: env.VISION_OCR_LANG || 'eng',
            timeoutMs: Math.max(2000, int(env.VISION_OCR_TIMEOUT_MS, 20000)),
        },
        models: { dir: require('path').resolve(env.DATA_DIR || require('path').join(__dirname, '..', 'data'), 'models') },
        offers: {
            dealsUrl: env.VISION_DEALS_SEARCH_URL || '',
            shoesUrl: env.VISION_SHOES_SEARCH_URL || '',
        },

        // Image inputs: upload (multipart), a data: URL, or a public https URL fetched with the private-address
        // guard. No image bytes are stored in the database or written to a page.
        images: {
            maxMb: Math.min(20, Math.max(1, int(env.VISION_IMAGE_MAX_MB, 8))),
            timeoutMs: Math.max(1000, int(env.VISION_IMAGE_TIMEOUT_MS, 10000)),
            allowPrivate: env.VISION_ALLOW_PRIVATE_URLS === '1' || env.VISION_ALLOW_PRIVATE_URLS === 'true',
        },
        faces: {
            modelsDir: modelsDir(env),
            key: env.VISION_FACE_KEY || '',
            allowedRegions: String(env.VISION_FACE_LIBRARY_REGIONS || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
            // F1 familiar faces: the owner picks the camera's region; a region on this list takes a named person's
            // consent first (Illinois, Texas, Washington, the EU and the UK). An unknown or unlisted region defaults
            // to strict, never to the looser mode.
            strictRegions: String(env.VISION_FACE_STRICT_REGIONS || 'US-IL,US-TX,US-WA,EU,EU-*,GB,UK,UNKNOWN')
                .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
            consentRequestDays: Math.min(90, Math.max(1, int(env.VISION_FACE_CONSENT_REQUEST_DAYS, 14))),
            threshold: (() => {
                const raw = String(env.VISION_FACE_MATCH_THRESHOLD || '').trim();
                const n = raw ? Number(raw) : 0.363;
                return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.363;
            })(),
        },

        // The UI check: a static layout pass over HTML or a fetched page (no JavaScript executed), plus a
        // screenshot path through the local OCR boxes and sharp pixel sampling. Nothing leaves this host.
        ui: {
            maxHtmlBytes: Math.min(5 * 1024 * 1024, Math.max(64 * 1024, int(env.VISION_UI_MAX_HTML_KB, 1024) * 1024)),
            timeoutMs: Math.max(1000, int(env.VISION_UI_TIMEOUT_MS, 10000)),
            allowPrivate: env.VISION_ALLOW_PRIVATE_URLS === '1' || env.VISION_ALLOW_PRIVATE_URLS === 'true',
            maxFindings: Math.min(500, Math.max(10, int(env.VISION_UI_MAX_FINDINGS, 200))),
        },
    };
}

module.exports = { load };
