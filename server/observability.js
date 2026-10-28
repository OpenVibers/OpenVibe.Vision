'use strict';

/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready): the database is required; the Network signing
 * key, the OAuth client, OpenVibe.AI and the local OCR binary are optional and say so. Vision serves local OCR
 * and the UI check without them; ask and compare need AI only when they cannot answer locally.
 */
const { jwksStatus } = require('openvibe-sdk/auth');
const { createReadiness } = require('openvibe-shared/ready');

function createServiceReadiness({ s, config, valkey = null, release = null, ai = null, ocr = null, models = null }) {
    return createReadiness({
        service: 'vision',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: async () => {
                    const r = await s.db.ready();
                    return r.ok ? { ok: true, detail: r.detail } : r.error;
                },
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-caller limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    const statuses = jwksStatus();
                    if (!statuses.length) return 'no JWKS clients (misconfigured)';
                    const first = statuses[0];
                    if (!first.ready) return 'Network signing key not loaded yet: sign-in and the API are unavailable';
                    return { ok: true, detail: { keys: first.keys, failures: first.failures, stale: first.stale, fetched_at: first.fetchedAt } };
                },
            },
            { name: 'oauth_client', required: false, check: () => (config.oauth.clientSecret ? true : 'OV_OAUTH_CLIENT_SECRET unset: sign-in and AI calls cannot complete') },
            { name: 'ai', required: false, check: () => (ai && ai.enabled ? { ok: true, detail: { mode: 'on demand: a run is made only when a local engine cannot answer' } } : 'OpenVibe.AI is not configured: local OCR and the UI check still serve') },
            { name: 'local_clip', required: false, check: () => models && models.clipReady() ? { ok: true, detail: 'quantized CLIP weights present' } : 'CLIP weights missing: private search, product embedding and moments return 503' },
            { name: 'local_detector', required: false, check: () => models && models.detectorReady() ? { ok: true, detail: 'quantized DETR weights present' } : 'DETR weights missing: watched object classes return 503; scene change still works' },
            {
                name: 'local_ocr', required: false,
                check: async () => {
                    if (!ocr) return 'no local OCR engine';
                    const v = await ocr.available();
                    return v ? { ok: true, detail: v } : 'tesseract is not installed: OCR and the screenshot pass answer 503';
                },
            },
        ],
    });
}

module.exports = { createServiceReadiness };
