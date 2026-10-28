'use strict';

/**
 * /api/v1 — OpenVibe.Vision's JSON API.
 *
 *   GET  /ping
 *   POST /ask                    one image and a question: local OCR first, then OpenVibe.AI
 *   POST /ocr                    the local Tesseract reader; `fallback=1` asks AI only when it finds no text
 *   POST /compare                local OCR vs one or more AI model hints, side by side, with cost and latency
 *   POST /ui-check               overflow, cut-off, contrast, overlap and layering faults from html, url or image
 *   GET  /answers/:id            one saved answer (its owner, or a service holding vision.ask)
 *   GET  /ui-checks/:id          one saved UI check (its owner, or a service holding vision.ui.check)
 *   GET  /models                 the AI route's offered provider:model hints (no subject data)
 *   GET  /benchmarks             aggregate compare samples: model, task, samples, mean latency and cost
 *
 * An image is a multipart `image` field, a JSON `image` data URL, or a JSON `image_url` public URL. Errors are
 * application/problem+json with a code. A person is the vision_at session cookie or a Network user token as a
 * Bearer; a service token needs exactly the capability named on the route.
 */
const express = require('express');
const multer = require('multer');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { loadImage } = require('../vision/images');
const { VisionError } = require('../vision/service');

function createApi(ctx) {
    const { config, s, principal, store, vision, ai, ocr, fetchImpl, networkTools, models: localModels } = ctx;
    const r = asyncRouter();
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.images.maxMb * 1024 * 1024, files: 1 } });

    // A data: URL is base64, so an 8 MB image is about 10.7 MB of JSON. Keep the parser above that, below the
    // multipart cap. The decoded bytes are checked again by loadImage.
    r.use(express.json({ limit: `${Math.ceil(config.images.maxMb * 1.5) + 2}mb` }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // Per-actor limits on top of the per-address limit in server/app.js. A service caller is bounded too.
    const buckets = new Map();
    function windowCount(key, windowMs, limit) {
        const now = Date.now();
        let b = buckets.get(key);
        if (!b || now - b.start >= windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
        b.n += 1;
        return b.n <= limit;
    }
    r.use((req, res, next) => {
        const p = req.principal;
        const who = p && p.kind === 'user' ? `user:${p.subject}` : p && p.kind === 'service' ? `svc:${p.sub}` : null;
        if (who) {
            const okMinute = windowCount(`${who}:m`, 60_000, config.limits.minute);
            const okHour = windowCount(`${who}:h`, 60 * 60_000, config.limits.hour);
            if (!okMinute || !okHour) return problem(res, 429, 'vision.rate_limited', 'too many requests from this account; retry shortly');
            if (buckets.size > 20_000) {
                for (const [k, b] of buckets) if (Date.now() - b.start > 2 * 60 * 60_000) buckets.delete(k);
            }
        }
        return next();
    });

    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    const invalid = (res, detail) => problem(res, 400, 'vision.invalid', detail);
    const isPerson = (req) => req.principal && req.principal.kind === 'user';
    const isMachine = (req) => req.principal && req.principal.kind === 'service';

    const attachUpload = (req, res, next) => upload.single('image')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return problem(res, 413, 'vision.image_too_large', `the image is larger than ${config.images.maxMb} MB`);
        if (err.code === 'LIMIT_UNEXPECTED_FILE') return invalid(res, 'send one image in the field named image');
        return next(err);
    });

    function bodyOf(req) { return req.body && typeof req.body === 'object' ? req.body : {}; }
    async function imageOf(req) {
        const b = bodyOf(req);
        const got = await loadImage({
            file: req.file && req.file.buffer,
            imageUrl: b.image_url,
            image: b.image,
            config,
            fetchImpl,
        });
        return got;
    }
    function viewportOf(req) {
        const b = bodyOf(req);
        let v = b.viewport;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
        return {
            w: Math.max(160, Math.min(10000, Number((v && v.w) || b.viewport_w || req.query.width) || 1280)),
            h: Math.max(160, Math.min(10000, Number((v && v.h) || b.viewport_h || req.query.height) || 800)),
        };
    }
    async function run(res, fn, status = 200) {
        try {
            const out = await fn();
            return res.status(status).json(out);
        } catch (err) {
            if (err instanceof VisionError) {
                if (err.extra && Object.keys(err.extra).length) return res.status(err.status).json({ type: `https://openvibe.vision/problems/${err.code}`, title: 'Request refused', status: err.status, code: err.code, detail: err.detail, ...err.extra });
                return problem(res, err.status, err.code, err.detail);
            }
            if (err && err.code && /^image\./.test(err.code)) {
                const status2 = err.code === 'image.too_large' ? 413 : err.code === 'image.private_url' ? 422 : 400;
                return problem(res, status2, `vision.${err.code.replace('.', '_')}`, err.message);
            }
            throw err;
        }
    }

    r.get('/ping', (_req, res) => res.json({ ok: true, service: config.service }));

    // Private tools use the verified owner user token as the caller. Rooms should forward a delegated user token;
    // a bare service capability cannot assert ownership of private media.
    const ownerOnly = (req, res, next) => isPerson(req) ? next() : problem(res, 403, 'vision.owner_required', 'a verified owner user token is required');
    const owner = (req) => req.principal.subject;
    const noRemoteSource = (req, res, next) => bodyOf(req).image_url ? invalid(res, 'private tools accept uploaded bytes or a data URL, not an unverified source URL') : next();

    r.post('/alt', principal.requireCapability('vision.alt'), attachUpload, (req, res) => run(res, async () => ({ answer: await networkTools.alt(await imageOf(req)) }), 201));
    r.post('/index', principal.requireCapability('vision.find'), ownerOnly, attachUpload, noRemoteSource, (req, res) => run(res, async () => {
        const b = bodyOf(req);
        return { answer: await networkTools.index(owner(req), b.item_id, await imageOf(req), b.result_url) };
    }, 201));
    r.get('/find', principal.requireCapability('vision.find'), ownerOnly, (req, res) => run(res, async () => {
        const q = String(req.query.q || '').trim();
        if (!q || q.length > 500) throw new VisionError(400, 'vision.invalid_query', 'q must contain 1–500 characters');
        return { answer: await networkTools.find(owner(req), q) };
    }));
    r.post('/find', principal.requireCapability('vision.find'), ownerOnly, attachUpload, noRemoteSource, (req, res) => run(res, async () => ({ answer: await networkTools.find(owner(req), await imageOf(req)) })));
    r.post('/receipt', principal.requireCapability('vision.receipt'), attachUpload, (req, res) => run(res, async () => ({ answer: await networkTools.readReceipt(await imageOf(req), bodyOf(req).fallback === true || bodyOf(req).fallback === 'true') }), 201));
    r.post('/product', principal.requireCapability('vision.product'), attachUpload, (req, res) => run(res, async () => ({ answer: await networkTools.product(await imageOf(req), bodyOf(req).allow_rerank === true || bodyOf(req).allow_rerank === 'true') }), 201));
    r.post('/watch', principal.requireCapability('vision.watch'), ownerOnly, attachUpload, noRemoteSource, (req, res) => run(res, async () => {
        const b = bodyOf(req);
        const classes = Array.isArray(b.classes) ? b.classes : String(b.classes || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!classes.length || classes.length > 20) throw new VisionError(400, 'vision.invalid_classes', 'send 1–20 watched classes');
        const previous = b.previous_image ? await loadImage({ image: b.previous_image, config, fetchImpl }) : null;
        return { answer: await networkTools.watch(await imageOf(req), classes, previous) };
    }, 201));
    r.post('/moments', principal.requireCapability('vision.moments'), ownerOnly, (req, res) => run(res, async () => {
        const b = bodyOf(req);
        if (!Array.isArray(b.frames) || b.frames.length < 1 || b.frames.length > 30) throw new VisionError(400, 'vision.invalid_frames', 'send 1–30 timestamped frames');
        const frames = [];
        for (const f of b.frames) {
            if (!Number.isFinite(Number(f.timestamp_ms)) || Number(f.timestamp_ms) < 0) throw new VisionError(400, 'vision.invalid_timestamp', 'each frame needs timestamp_ms');
            if (!f.image && !f.image_url) throw new VisionError(400, 'vision.invalid_frames', 'each frame needs image or image_url');
            frames.push({ timestamp_ms: Number(f.timestamp_ms), image: await loadImage({ image: f.image, imageUrl: f.image_url, config, fetchImpl }) });
        }
        const prompts = Array.isArray(b.prompts) ? b.prompts.map(String).filter(Boolean).slice(0, 10) : ['a goal', 'a funny fall'];
        return { answer: await networkTools.moments(frames, prompts) };
    }, 201));

    // ── OCR: local first, anonymous local calls allowed ─────
    r.post('/ocr', attachUpload, principal.optional('vision.ocr', { allowAnonymous: true }), async (req, res) => {
        const b = bodyOf(req);
        const fallback = b.fallback === true || b.fallback === '1' || b.fallback === 'true';
        if (req.principal.kind === 'anonymous' && fallback) return problem(res, 401, 'token.required', 'AI fallback needs a signed-in person or a service token holding vision.ocr');
        return run(res, async () => {
            const image = await imageOf(req);
            return await vision.ocr({
                requester: req.principal.requester || 'anonymous', subject: isPerson(req) ? req.principal.subject : null,
                image, lang: b.lang, fallback, model: b.model,
            });
        }, 201);
    });

    // ── Ask: local OCR answers a read question, else AI ─────
    // /ask is the product's name; /describe is the operation name in the plan's API list. Same handler.
    const askHandler = (defaultTask) => async (req, res) => {
        const b = bodyOf(req);
        const task = b.task || defaultTask;
        const mode = b.mode || 'auto';
        const question = String(b.question || b.q || '').trim();
        const readish = vision.isReadTask(task, question);
        if (req.principal.kind === 'anonymous' && mode !== 'local' && !readish) {
            return problem(res, 401, 'token.required', 'Ask needs a signed-in person or a service token holding vision.ask; anonymous callers can use mode=local or a read question that the local OCR engine answers.');
        }
        return run(res, async () => {
            const image = await imageOf(req);
            const out = await vision.ask({
                requester: req.principal.requester || 'anonymous', subject: isPerson(req) ? req.principal.subject : null,
                image, task, question, mode: req.principal.kind === 'anonymous' ? 'local' : mode, lang: b.lang, model: b.model,
            });
            return { answer: out };
        }, 201);
    };
    r.post('/ask', attachUpload, principal.optional('vision.ask', { allowAnonymous: true }), askHandler('ask'));
    r.post('/describe', attachUpload, principal.optional('vision.ask', { allowAnonymous: true }), askHandler('describe'));

    // ── Compare: local + AI hints, side by side ────────────
    r.post('/compare', principal.optional('vision.compare'), attachUpload, async (req, res) => {
        const b = bodyOf(req);
        const models = Array.isArray(b.models) ? b.models : (typeof b.models === 'string' && b.models.trim() ? b.models.split(',').map((x) => x.trim()) : []);
        return run(res, async () => {
            const image = await imageOf(req);
            const out = await vision.compare({
                requester: req.principal.requester || 'anonymous', subject: isPerson(req) ? req.principal.subject : null,
                image, task: b.task || 'ask', question: b.question || b.q || '', models, lang: b.lang,
            });
            return { answer: out, compare: out.compare };
        }, 201);
    });

    // ── UI check: HTML, URL or screenshot; local only ──────
    r.post('/ui-check', attachUpload, principal.optional('vision.ui.check', { allowAnonymous: true }), async (req, res) => {
        const b = bodyOf(req);
        const html = typeof b.html === 'string' ? b.html : null;
        const url = typeof b.url === 'string' ? b.url.trim() : null;
        if (!html && !url && !req.file && !b.image && !b.image_url) return invalid(res, 'send html, url, an image file, an image data URL, or image_url');
        if (html && Buffer.byteLength(html, 'utf8') > config.ui.maxHtmlBytes) return problem(res, 413, 'vision.ui_too_large', 'that HTML is larger than the UI check limit');
        return run(res, async () => {
            const viewport = viewportOf(req);
            let out; let image = null;
            if (req.file || b.image || b.image_url) {
                image = await imageOf(req);
                out = await require('../vision/ui-check').check({ imageBuffer: image.buffer, viewport, ocr, maxFindings: config.ui.maxFindings });
            } else if (html) {
                out = await require('../vision/ui-check').check({ html, viewport, maxFindings: config.ui.maxFindings });
            } else {
                out = await require('../vision/ui-check').check({ url, viewport, config, fetchImpl, maxFindings: config.ui.maxFindings });
            }
            const saved = await store.saveUiCheck({
                subject: isPerson(req) ? req.principal.subject : null,
                requester: req.principal.requester || 'anonymous',
                source: out.source, url: out.url || null, imageSha256: image ? image.sha256 : null,
                viewport: out.viewport, engine: out.engine, findings: out.findings, summary: out,
            });
            return { check: { ...saved, findings: out.findings, counts: out.counts, severity: out.severity, warnings: out.warnings, summary_text: out.summary } };
        }, 201);
    });

    // ── Reads ──────────────────────────────────────────────
    r.get('/answers/:id', principal.optional('vision.ask', { allowAnonymous: true }), async (req, res) => {
        const row = await store.answerById(String(req.params.id || ''));
        if (!row) return problem(res, 404, 'vision.not_found', 'No such answer.');
        const owner = await store.answerSubject(row.id);
        const mine = isPerson(req) && Boolean(owner) && req.principal.subject === owner;
        const service = isMachine(req);
        if (!mine && !service) return problem(res, 404, 'vision.not_found', 'No such answer.');
        res.set('Cache-Control', 'private, no-store');
        return res.json(row);
    });

    r.get('/ui-checks/:id', principal.optional('vision.ui.check', { allowAnonymous: true }), async (req, res) => {
        const row = await store.uiCheckById(String(req.params.id || ''));
        if (!row) return problem(res, 404, 'vision.not_found', 'No such UI check.');
        const owner = await store.uiCheckSubject(row.id);
        const mine = isPerson(req) && Boolean(owner) && req.principal.subject === owner;
        const service = isMachine(req);
        if (!mine && !service) return problem(res, 404, 'vision.not_found', 'No such UI check.');
        res.set('Cache-Control', 'private, no-store');
        return res.json(row);
    });

    // ── Model hints and benchmarks (no subject data) ───────
    let modelCache = null;
    r.get('/models', async (_req, res) => {
        if (!modelCache || Date.now() - modelCache.at > 5 * 60_000) {
            const offered = ai.enabled ? await ai.offeredModels().catch(() => []) : [];
            modelCache = { at: Date.now(), offered };
        }
        res.set('Cache-Control', 'public, max-age=300');
        return res.json({
            ai: ai.enabled,
            configured: config.ai.models,
            offered: modelCache.offered,
            local: ['tesseract', ...(localModels.clipReady() ? ['CLIP ViT-B/32 q8'] : []), ...(localModels.detectorReady() ? ['DETR ResNet-50 q8'] : []), 'histogram'],
            note: 'provider:model hints; OpenVibe.AI\'s router is the authority and its provenance is what an answer reports',
        });
    });

    r.get('/benchmarks', async (req, res) => {
        const task = typeof req.query.task === 'string' && req.query.task ? req.query.task : null;
        const limit = req.query.limit == null ? 50 : Number.parseInt(req.query.limit, 10);
        if (!Number.isFinite(limit) || limit < 1 || limit > 100) return invalid(res, 'limit must be from 1 to 100');
        if (task && !['ask', 'describe', 'ocr', 'translate', 'identify', 'count'].includes(task)) return invalid(res, 'task must be a compare task');
        const rows = await store.benchmarks({ task, limit });
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ count: rows.length, benchmarks: rows });
    });

    // multer's own errors: the route-level handler above turns the common ones into problem+json.
    // eslint-disable-next-line no-unused-vars
    r.use((err, req, res, next) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return problem(res, 413, 'vision.image_too_large', `the image is larger than ${config.images.maxMb} MB`);
        return next(err);
    });

    return r;
}

module.exports = { createApi };
