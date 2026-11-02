'use strict';

/**
 * The v1 engine chooser. Cheapest first, as the plan says: the local OCR reader answers a read task when it can;
 * otherwise OpenVibe.AI's routed vision model answers. Every result carries the engine/model that actually
 * answered, the reason it was chosen, the measured latency and the cost AI reported (0 for local).
 *
 * compare runs the same image through the local reader and one or more AI hints side by side, records each
 * sample and stores the aggregate. A model hint is never reported as the answerer: AI's provenance wins.
 */
const { AiError } = require('./ai');
const { forModel } = require('./images');

class VisionError extends Error {
    constructor(status, code, detail, extra = {}) {
        super(detail || code);
        this.name = 'VisionError';
        this.status = status;
        this.code = code;
        this.detail = detail || code;
        this.extra = extra;
    }
}

const TASKS = new Set(['ask', 'describe', 'identify', 'count', 'translate', 'ocr', 'compare']);
const READ_RE = /\b(read|say|says|said|text|word|words|label|labels|sign|signs|receipt|receipts|handwriting|ocr|written|print|printed|translate|translation|caption|menu|address|number)\b/i;

function isReadTask(task, question) {
    if (task === 'ocr') return true;
    // Local OCR can read the words, but it cannot translate them: a translate task (or a question that asks for a
    // translation) goes to the model when auto mode is on. mode=local still returns the reading, and says so.
    if (task === 'translate') return false;
    if (/\btranslate|translation\b/i.test(String(question || ''))) return false;
    return task === 'ask' && READ_RE.test(String(question || ''));
}

function asTask(value) {
    const t = String(value || 'ask').toLowerCase();
    return TASKS.has(t) ? t : null;
}

function createVision({ config, s, images, ocr, ai, store, log = console }) {
    const maxAiSamples = 3;

    function localResult(image, task, { question = null, lang = null, startedAt = Date.now() } = {}) {
        return ocr.recognize(image.buffer, { lang }).then((r) => ({
            engine: 'local',
            ok: Boolean(r.ok && String(r.text || '').trim()),
            text: r.ok ? String(r.text || '').trim() : null,
            model: r.ok ? 'tesseract' : null,
            provider: 'local',
            route: 'local.ocr',
            reason: r.ok ? 'the local OCR reader answered the read task; no model was called' : null,
            costUsd: 0,
            ms: Number(r.ms) || (Date.now() - startedAt),
            errorCode: r.ok ? null : r.code,
            detail: r.ok ? null : r.detail,
            confidence: r.ok ? r.confidence : null,
            words: r.ok ? r.words : [],
            version: r.ok ? r.version : null,
            question,
        }));
    }

    async function aiResult(image, task, { question = null, model = null } = {}) {
        const normal = await forModel(image.buffer);
        const started = Date.now();
        try {
            const a = await ai.answer({ dataUrl: normal.dataUrl, task, question, model });
            return {
                engine: 'ai', ok: true, text: a.text, model: a.model, provider: a.provider, route: a.route,
                reason: a.reason, costUsd: a.costUsd, ms: a.ms || (Date.now() - started), errorCode: null,
                detail: null, runId: a.runId, synthetic: a.synthetic, usage: a.usage,
            };
        } catch (err) {
            const code = (err && err.code) || 'vision.ai_failed';
            const detail = (err && (err.detail || err.message)) || 'OpenVibe.AI did not answer';
            return { engine: 'ai', ok: false, text: null, model: model || null, provider: null, route: null, reason: null, costUsd: 0, ms: Date.now() - started, errorCode: code, detail: String(detail).slice(0, 500) };
        }
    }

    /**
     * ask: one image, one question. `mode`:
     *   auto (default)  local OCR for a read task when it finds text, else AI
     *   local           local OCR only; never a model
     *   ai              AI directly (the caller knows it needs a model), OCR task still prompts a read
     */
    async function ask({ requester, subject = null, image, task = 'ask', question = '', mode = 'auto', lang = null, model = null }) {
        const t = asTask(task);
        if (!t || t === 'compare') throw new VisionError(400, 'vision.invalid_task', 'task must be ask, describe, identify, count, translate or ocr');
        if (mode !== 'auto' && mode !== 'local' && mode !== 'ai') throw new VisionError(400, 'vision.invalid_mode', 'mode must be auto, local or ai');
        const started = Date.now();
        const q = String(question || '').trim().slice(0, 2000);
        if (t !== 'describe' && t !== 'ocr' && !q && mode !== 'local') throw new VisionError(400, 'vision.question_required', 'ask, identify, count and translate need a question');

        let local = null;
        if (mode !== 'ai' && (isReadTask(t, q) || mode === 'local')) {
            local = await localResult(image, t, { question: q, lang, startedAt: started });
        } else if (mode === 'local' && t !== 'ocr') {
            local = await localResult(image, t, { question: q, lang, startedAt: started });
        }

        let chosen = null;
        if (mode === 'local' || (local && local.ok && mode === 'auto')) {
            chosen = local || await localResult(image, t, { question: q, lang, startedAt: started });
            if (!chosen.ok && mode === 'local') throw new VisionError(502, chosen.errorCode || 'vision.ocr_failed', chosen.detail || 'the local OCR engine could not read that image');
        } else {
            if (!ai.enabled) {
                if (local && local.ok) chosen = local;
                else throw new VisionError(503, 'vision.ai_unavailable', 'OpenVibe.AI is not configured and the local OCR reader found no text for this task');
            } else {
                chosen = await aiResult(image, t, { question: q, model });
                if (!chosen.ok) {
                    if (local && local.ok) chosen = local;
                    else throw new VisionError(chosen.errorCode === 'vision.ai_unavailable' ? 503 : 502, chosen.errorCode || 'vision.ai_failed', chosen.detail || 'OpenVibe.AI did not answer');
                }
            }
        }

        const latency = Date.now() - started;
        const answer = {
            engine: chosen.engine, model: chosen.model, provider: chosen.provider, route: chosen.route,
            reason: chosen.reason || (chosen.engine === 'local' ? 'the local OCR reader was the cheapest engine that could answer' : 'OpenVibe.AI routed the task to the model that answered'),
            confidence: chosen.confidence == null ? null : chosen.confidence,
            ...(chosen.words && chosen.words.length ? { words: chosen.words.slice(0, 200) } : {}),
            ...(chosen.runId ? { run_id: chosen.runId } : {}),
            ...(chosen.usage ? { usage: chosen.usage } : {}),
        };
        const text = chosen.text;
        const saved = await store.saveAnswer({
            subject, requester, task: t, question: q || null, mode, image,
            text, answer, model: chosen.model, provider: chosen.provider, route: chosen.route, reason: answer.reason,
            costUsd: chosen.costUsd, latencyMs: latency,
        });
        return { ...saved, engine: chosen.engine, confidence: chosen.confidence == null ? null : chosen.confidence };
    }

    /** OCR: local first; `fallback: true` asks AI only when the local reader found nothing usable. */
    async function ocrImage({ requester, subject = null, image, lang = null, fallback = false, model = null }) {
        const started = Date.now();
        const local = await localResult(image, 'ocr', { lang, startedAt: started });
        let chosen = local;
        if ((!local.ok || !String(local.text || '').trim()) && fallback) {
            if (ai.enabled) chosen = await aiResult(image, 'ocr', { question: 'Read all visible text verbatim.', model });
            if (!chosen.ok && local.ok) chosen = local;
        }
        if (!chosen.ok) {
            const status = chosen.errorCode === 'vision.ai_unavailable' || chosen.errorCode === 'vision.ocr_unavailable' ? 503 : 502;
            throw new VisionError(status, chosen.errorCode || 'vision.ocr_failed', chosen.detail || 'no local OCR text was found');
        }
        const text = chosen.text;
        const answer = {
            engine: chosen.engine, model: chosen.model, provider: chosen.provider, route: chosen.route,
            reason: chosen.reason || (chosen.engine === 'local' ? 'the local OCR reader answered first' : 'the local OCR reader found no text, so OpenVibe.AI was asked'),
            confidence: chosen.confidence == null ? null : chosen.confidence,
            ...(chosen.words && chosen.words.length ? { words: chosen.words.slice(0, 500) } : {}),
            ...(chosen.runId ? { run_id: chosen.runId } : {}),
        };
        const saved = await store.saveAnswer({
            subject, requester, task: 'ocr', question: null, mode: fallback ? 'auto' : 'local', image,
            text, answer, model: chosen.model, provider: chosen.provider, route: chosen.route, reason: answer.reason,
            costUsd: chosen.costUsd, latencyMs: Date.now() - started,
        });
        return { ...saved, engine: chosen.engine, confidence: chosen.confidence == null ? null : chosen.confidence };
    }

    /**
     * compare: local OCR and AI runs on the same image. `models` are hints; when empty, the AI route's offered
     * models are read (up to three) and one AI run is made for each distinct hint. AI's provenance is recorded.
     */
    async function compare({ requester, subject = null, image, task = 'ask', question = '', models = [], lang = null }) {
        const t = asTask(task);
        if (!t || t === 'compare') throw new VisionError(400, 'vision.invalid_task', 'compare needs ask, describe, identify, count, translate or ocr');
        const started = Date.now();
        const q = String(question || '').trim().slice(0, 2000) || 'Read this image and describe what it shows.';
        const samples = [];
        const local = await localResult(image, t, { question: q, lang, startedAt: started });
        samples.push({ engine: 'local', requestedModel: 'tesseract', model: local.model, provider: local.provider, route: local.route, ok: local.ok, text: local.text, costUsd: local.costUsd, ms: local.ms, errorCode: local.errorCode });

        if (ai.enabled) {
            let hints = (Array.isArray(models) ? models : []).map((m) => String(m || '').trim()).filter(Boolean).slice(0, maxAiSamples);
            if (!hints.length) {
                const offered = await ai.offeredModels();
                hints = (offered.length ? offered : [{ provider: 'ai', model: null }])
                    .map((o) => (o.provider && o.provider !== 'ai' ? `${o.provider}:${o.model || ''}` : (o.model || 'openvibe')))
                    .filter(Boolean).slice(0, maxAiSamples);
            }
            for (const hint of hints) {
                const a = await aiResult(image, t, { question: q, model: hint });
                samples.push({ engine: 'ai', requestedModel: hint, model: a.model, provider: a.provider, route: a.route, ok: a.ok, text: a.ok ? a.text : null, costUsd: a.costUsd, ms: a.ms, errorCode: a.errorCode });
            }
        }

        const saved = await store.saveCompare({ subject, requester, task: t, image, question: q, samples });
        return {
            ...saved.answer,
            engine: 'compare',
            compare: saved.samples.map((x) => ({ ...x, text: x.text == null ? null : (x.text) })),
            local: { ok: local.ok, model: local.model, confidence: local.confidence == null ? null : local.confidence, error_code: local.errorCode || null },
            reason: `${saved.samples.length} engines ran on the same image; local OCR is free and AI runs report their own cost and latency`,
        };
    }

    return { ask, ocr: ocrImage, compare, isReadTask, TASKS };
}

module.exports = { createVision, VisionError, isReadTask, asTask, TASKS };
