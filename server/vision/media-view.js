'use strict';

/**
 * Vision → Media for the operator's evidence view (VIS-6 review follow-up).
 *
 * A quarantined object refuses even a signed read. That is correct for everyone except the operator who
 * presses Show on the review page. This client calls Media's operator routes with Vision's own service
 * principal: `media.object.review.view` for a 60-second view and `media.object.review.decide` for an
 * operator's overruling category (which releases Media's evidence hold). Both calls are logged by Media.
 */
const { serviceAuth } = require('openvibe-contracts');

function createMediaView({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(process.env.MEDIA_URL || process.env.OV_MEDIA_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '');
    const secret = config.oauth && config.oauth.clientSecret;
    const token = (scope) => (secret ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId || 'vision',
        clientSecret: secret,
        audience: 'openvibe.media',
        scope,
        fetchImpl,
    }) : null);
    const viewTokens = token('media.object.review.view');
    const decideTokens = token('media.object.review.decide');

    async function call(path, body, tokens, retried = false) {
        if (!tokens) throw new Error('Media is not configured for Vision (no service principal)');
        const res = await fetchImpl(`${base}${path}`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && !retried) { try { tokens.invalidate(); } catch { /* older client */ } return await call(path, body, tokens, true); }
        const out = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`Media ${res.status}: ${(out && (out.detail || out.code)) || 'failed'}`);
        return out;
    }

    /** POST /api/v2/:app/objects/:id/operator-view → { url, expires_at }. */
    async function operatorView({ app, objectId, reason = 'operator review' }) {
        if (!app || !objectId) throw new Error('the review has no Media object to show');
        return await call(`/api/v2/${encodeURIComponent(app)}/objects/${encodeURIComponent(objectId)}/operator-view`, { reason }, viewTokens);
    }

    /** Apply an operator's category in Media (releases or places the evidence hold). */
    async function decide({ app, objectId, category, reportId = null, by = null }) {
        if (!app || !objectId) return null;
        return await call(`/api/v2/${encodeURIComponent(app)}/objects/${encodeURIComponent(objectId)}/review-decision`, {
            category, report_id: reportId, decided_by: by,
        }, decideTokens);
    }

    function available() { return Boolean(secret); }
    return { available, operatorView, decide };
}

module.exports = { createMediaView };
