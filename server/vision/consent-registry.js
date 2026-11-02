'use strict';
/**
 * OpenVibe.Network's consent registry, as Vision sees it for F1 (L24; Contracts 0.256.0).
 *
 *   allowed(subject)      POST /internal/consent/check { purpose: 'face.recognize', feature: 'library' }
 *   notify(subject, n)    POST /internal/notifications/push { subject, … }   (a consent request)
 *
 * Both use Vision's own client-credentials token. A registry that cannot answer means "not allowed" and a request
 * that cannot be sent is simply not sent: the owner still gets the private link and can send it instead. Neither
 * call logs a subject, a face or a crop.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

function createConsentRegistry({ config, fetchImpl = globalThis.fetch, log = console }) {
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth.clientSecret
        ? createServiceTokenClient({
            tokenUrl: `${base}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.network', scope: 'network.consent.read network.notifications.push', fetch: fetchImpl,
        })
        : null;

    async function call(path, body) {
        if (!tokens) return null;
        let token;
        try { token = await tokens.getToken(); } catch { return null; }
        try {
            const res = await fetchImpl(`${base}${path}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(Math.max(1500, Number(config.upstreamTimeoutMs) || 5000)),
            });
            if (!res.ok) return null;
            return await res.json().catch(() => null);
        } catch {
            return null;
        }
    }

    /** Strict mode: may this person's face be recognised in a camera owner's library? Missing answer = no. */
    async function allowed(subject) {
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject || ''))) return false;
        const data = await call('/internal/consent/check', { purpose: 'face.recognize', feature: 'library', subjects: [subject] });
        return Boolean(data && data.allowed && data.allowed[subject] === true);
    }

    /** Send a consent request to a named person who has a Network account. Missing answer = not sent. */
    async function notify(subject, { title, message, url } = {}) {
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject || ''))) return { sent: false };
        const data = await call('/internal/notifications/push', {
            subject,
            type: 'FAMILIAR_FACES_CONSENT',
            category: 'system',
            priority: 'normal',
            service: 'vision',
            title: String(title || 'A camera owner named you').slice(0, 160),
            message: String(message || 'Open their consent request to choose whether your face may be recognised.').slice(0, 1000),
            url: url == null ? null : String(url).slice(0, 1000),
        });
        return { sent: Boolean(data && data.ok) };
    }

    return { allowed, notify, configured: Boolean(tokens) };
}

module.exports = { createConsentRegistry };
