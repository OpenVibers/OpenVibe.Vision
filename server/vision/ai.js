'use strict';

/**
 * OpenVibe.AI is the only model gateway Vision uses. There is no provider key here, no direct provider URL, and
 * no paid provider of Vision's own: a first-party service token (client `vision`, audience `openvibe.ai`,
 * capability `ai.run.create`, namespace `ai.*`) reaches the OpenAI-compatible endpoint, so AI's routing, quotas,
 * cache, provenance and cost accounting all apply. `x_openvibe` is kept on every answer, because the answer must
 * say which model answered and why.
 *
 * The model in the request is a hint only: AI's router is the authority and may answer from a pool or a fallback.
 * The provider and model Vision reports are always the ones AI says answered, never the hint.
 */
const { serviceAuth } = require('openvibe-contracts');

class AiError extends Error {
    constructor(status, code, detail) {
        super(detail || code);
        this.name = 'AiError';
        this.status = status;
        this.code = code;
        this.detail = detail || code;
    }
}

const TASK_PROMPTS = {
    ask: 'Answer the question about the image precisely. Say when the image does not show the answer. If the answer is a count, give the number and name what you counted.',
    describe: 'Describe the image for someone who cannot see it: the scene, the objects, any visible text, and what is happening, people included.',
    identify: 'Identify what the image shows. Give the most specific answer the picture supports, and say what is uncertain.',
    count: 'Count what the question asks about. Give the number first, then list each item you counted.',
    translate: 'Read the visible text and translate it into the target language. Give the original text, then the translation.',
    ocr: 'Read every visible piece of text in the image, verbatim, preserving line breaks and reading order. Do not summarize and do not add anything that is not written.',
    compare: 'Answer the question about the image precisely, for a side-by-side comparison. Say when the image does not show the answer.',
};

const NO_IDENTITY = 'Never identify, name or recognise a person, and never use a face as identity.';

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((p) => {
            if (!p || typeof p !== 'object') return '';
            if (typeof p.text === 'string') return p.text;
            if (p.type === 'output_text' && typeof p.text === 'string') return p.text;
            return '';
        }).join('').trim();
    }
    return '';
}

function createAi({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const ai = config.ai;
    const tokenClient = config.oauth.clientSecret
        ? serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl || config.networkUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: ai.audience,
            scope: ai.scope,
            fetchImpl,
        })
        : null;
    const enabled = Boolean(ai.url && tokenClient);

    async function call(method, path, body, { retried = false } = {}) {
        if (!enabled) throw new AiError(503, 'vision.ai_unavailable', 'OpenVibe.AI is not configured: OV_OAUTH_CLIENT_SECRET is unset or OV_AI_URL is empty');
        let headers;
        try { headers = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokenClient.authHeaders()) }; }
        catch { throw new AiError(502, 'vision.ai_token_failed', 'OpenVibe.Network did not issue an AI token for Vision'); }
        let res;
        try {
            res = await fetchImpl(`${String(ai.url).replace(/\/+$/, '')}${path}`, {
                method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ai.timeoutMs),
            });
        } catch (err) {
            throw new AiError(502, 'vision.ai_unreachable', err && err.name === 'TimeoutError' ? 'OpenVibe.AI did not answer in time' : 'OpenVibe.AI could not be reached');
        }
        if (res.status === 401 && !retried) {
            try { tokenClient.invalidate(); } catch { /* older client */ }
            return call(method, path, body, { retried: true });
        }
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            const err = json && json.error && typeof json.error === 'object' ? json.error : null;
            const code = (err && err.code) || (json && (json.code || json.error)) || `ai.http_${res.status}`;
            const detail = (err && err.message) || (json && (json.detail || json.message)) || `OpenVibe.AI refused the run (${res.status})`;
            throw new AiError(res.status >= 500 ? 502 : res.status, String(code).slice(0, 80), String(detail).slice(0, 500));
        }
        return json;
    }

    /** The route's offered provider:model pairs; a hint for the compare slots, never a promise of the answer. */
    async function offeredModels() {
        if (!enabled) return [];
        try {
            const body = await call('GET', '/api/v1/routes');
            const routes = Array.isArray(body) ? body : (body && Array.isArray(body.routes) ? body.routes : []);
            const chat = routes.filter((r) => r && (r.capability === 'chat' || /chat|generate/i.test(String(r.key || ''))));
            const ordered = [...chat.filter((r) => r.key === 'default.chat'), ...chat.filter((r) => r.key !== 'default.chat')];
            const out = [];
            const seen = new Set();
            for (const r of ordered) {
                for (const c of [r.primary, ...(Array.isArray(r.pinned) ? r.pinned : []), ...(Array.isArray(r.fallbacks) ? r.fallbacks : [])]) {
                    if (!c || !c.provider) continue;
                    const key = `${c.provider}|${c.model || ''}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({ provider: String(c.provider).slice(0, 80), model: c.model == null ? null : String(c.model).slice(0, 120) });
                    if (out.length >= 6) return out;
                }
            }
            return out;
        } catch (err) {
            log.warn(`[OpenVibe.Vision] AI routes unavailable: ${(err && err.message) || err}`);
            return [];
        }
    }

    /**
     * One image question through AI. opts: dataUrl, task, question, model (a hint), target.
     * Returns the cleaned text plus AI's own provenance and usage. Throws AiError.
     */
    async function answer({ dataUrl, task = 'ask', question = '', model = null, target = null, maxTokens = null, temperature = null } = {}) {
        const prompt = TASK_PROMPTS[task] || TASK_PROMPTS.ask;
        const asked = String(question || '').trim().slice(0, 2000);
        const body = {
            // `model` is documented as a hint; AI's router picks and reports. Including it keeps the request honest.
            ...(model ? { model: String(model).slice(0, 120) } : {}),
            messages: [
                { role: 'system', content: `You are OpenVibe.Vision's image reader. ${prompt}\n${NO_IDENTITY}\nAnswer plainly and briefly; never invent details the picture does not show.` },
                { role: 'user', content: [
                    { type: 'text', text: asked || 'Describe this image.' },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ] },
            ],
            max_tokens: Math.min(2000, Math.max(32, Number(maxTokens) || ai.maxTokens)),
            temperature: temperature == null ? ai.temperature : temperature,
        };
        const started = Date.now();
        const out = await call('POST', '/v1/chat/completions', body);
        const choice = out && Array.isArray(out.choices) ? out.choices[0] : null;
        const raw = textOf(choice && choice.message && choice.message.content);
        if (!raw.trim()) throw new AiError(502, 'vision.ai_empty', 'OpenVibe.AI answered without any text');
        const x = out.x_openvibe || {};
        const usage = out.usage || {};
        return {
            text: raw,
            model: String(out.model || (x.model || '') || (model || 'openvibe')).slice(0, 120),
            provider: String(x.provider || '').slice(0, 80) || null,
            route: 'default.chat',
            costUsd: Math.max(0, Number(x.cost_usd != null ? x.cost_usd : 0) || 0),
            ms: Date.now() - started,
            runId: x.run_id || null,
            synthetic: Boolean(x.synthetic),
            usage: { tokens_in: Number(usage.prompt_tokens) || 0, tokens_out: Number(usage.completion_tokens) || 0 },
            reason: `OpenVibe.AI routed a ${task} run to ${x.provider || 'its pool'}${out.model ? `:${out.model}` : ''}; the answer is stored as written`,
            target: target || null,
        };
    }

    return { enabled, answer, offeredModels, call, tokenClient };
}

module.exports = { createAi, AiError, TASK_PROMPTS, NO_IDENTITY };
