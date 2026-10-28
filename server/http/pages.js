'use strict';

/**
 * Vision's server-rendered pages. Everything works without JavaScript: every form is a plain POST and every
 * result is a real page. Public pages are `public, max-age=60` with Vary: Cookie; a page drawn for a signed-in
 * person is `private, no-store`.
 *
 *   /                 the room: ask, compare, OCR and the UI check
 *   /ask              upload or URL + a question (POST /ask → /a/:id)
 *   /ocr              local OCR (POST /ocr → /a/:id, or inline for a guest)
 *   /compare          local OCR vs AI model hints (POST /compare → /a/:id)
 *   /ui-check         HTML, URL or screenshot (POST /ui-check → /ui/:id, or inline for a guest)
 *   /a/:id            one saved answer (owner or staff)
 *   /ui/:id           one saved UI check (owner or staff)
 *   /find, /read, /watch   the network tools (private search, receipts, camera)
 *   /people           the four face consents, each with its own signed switch
 *   /people/privacy   face retention, liveness and what never happens
 *   /developers       the API
 *   404
 */
const express = require('express');
const multer = require('multer');
const seo = require('openvibe-shared/seo');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { loadImage } = require('../vision/images');
const { check: uiCheck } = require('../vision/ui-check');
const { VisionError } = require('../vision/service');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const { isStaff } = require('../identity/staff');
const views = require('../views');
const peopleViews = require('../views/people');

const PUBLIC_CACHE = 'public, max-age=60';

function createPageRoutes(ctx) {
    const { config, s, store, vision, ai, ocr, faces, fetchImpl } = ctx;
    const r = asyncRouter();
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.images.maxMb * 1024 * 1024, files: 1 } });
    r.use(express.urlencoded({ extended: false, limit: '2mb' }));
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const staffViewer = (req) => isStaff(req.viewer);
    const notFromHere = (req, res) => page(req, res, { title: 'Not from this site', body: raw(html`<div class="vi-wrap vi-page-pad vi-narrow"><div class="vi-empty"><h1>That came from somewhere else</h1><p class="vi-muted">Use the form on <a href="/">OpenVibe.Vision</a>.</p></div></div>`) }, 403);
    const uploadMiddleware = (req, res, next) => upload.single('image')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return page(req, res, { title: 'That image is too large', body: raw(views.formError(`The image is larger than ${config.images.maxMb} MB.`)) }, 413);
        return next(err);
    });
    const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
    async function imageOf(req) {
        return await loadImage({ file: req.file && req.file.buffer, imageUrl: bodyOf(req).image_url, image: bodyOf(req).image, config, fetchImpl });
    }
    const viewportOf = (req) => {
        const b = bodyOf(req);
        return { w: Math.max(160, Math.min(10000, Number(b.viewport_w) || 1280)), h: Math.max(160, Math.min(10000, Number(b.viewport_h) || 800)) };
    };
    const formError = (message, status = 400) => ({ message, status });

    // ── Home ─────────────────────────────────────────────────
    r.get('/', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: null,
        description: 'Ask a picture, read text, check a page, find your images and use local face privacy tools with consent for personal matching.',
        jsonLd: homeJsonLd(config),
        body: raw(views.home({ signedIn: Boolean(signedIn(req)), ai: ai.enabled })),
    }));

    r.get('/people', async (req, res) => page(req, res, { title: 'People and consent', body: raw(peopleViews.people({
        signedIn: Boolean(signedIn(req)), consents: signedIn(req) ? await faces.listConsents(req.viewer.subject) : [],
        texts: faces.TEXT, regions: config.faces.allowedRegions,
    })) }));
    r.get('/people/privacy', (req, res) => page(req, res, { title: 'Face privacy', body: raw(peopleViews.privacy()) }));
    r.post('/people/consent/:feature', async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Sign in', body: raw(views.signIn({ title: 'People', text: 'Sign in to choose.', next: '/people' })) }, 401);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        try {
            if (req.body.enabled === 'yes') await faces.consent(req.viewer.subject, req.params.feature, {
                signedName: req.body.signed_name, textVersion: req.body.text_version, channel: req.body.channel,
                adult: req.body.adult === 'true', region: req.body.region,
            });
            else await faces.revoke(req.viewer.subject, req.params.feature, req.body.channel);
            return res.redirect(303, '/people');
        } catch (err) { return page(req, res, { title: 'People', body: raw(views.formError(err.detail || 'That choice could not be saved.')) }, err.status || 400); }
    });
    r.post('/people/enrol/:feature', uploadMiddleware, async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Sign in', body: raw(views.signIn({ title: 'People', text: 'Sign in to enrol.', next: '/people' })) }, 401);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        try { await faces.enrol(req.viewer.subject, req.params.feature, (await imageOf(req)).buffer, req.body.channel); return res.redirect(303, '/people'); }
        catch (err) { return page(req, res, { title: 'People', body: raw(views.formError(err.detail || err.message || 'Enrolment failed.')) }, err.status || 400); }
    });

    const toolPage = (req, res, title, intro, fields) => page(req, res, {
        title, cache: PUBLIC_CACHE,
        body: html`<main class="vi-wrap vi-page-pad vi-narrow"><header class="vi-section-head"><h1>${title}</h1><p class="vi-lede">${intro}</p></header><div class="vi-panel"><p class="vi-fine">These tools are available through Vision's JSON API. Sign in and send an image as multipart <code>image</code> or a data URL.</p>${fields}</div></main>`,
    });
    r.get('/find', (req, res) => toolPage(req, res, 'Find in your images', 'Private visual search uses local CLIP embeddings and checks the owner on each read.', html`<form method="get" action="/find"><label class="vi-label" for="vi-find-q">Search words</label><input id="vi-find-q" name="q" value="${String(req.query.q || '').slice(0, 500)}"><button type="submit">Search</button></form><p class="vi-fine">Room call: GET /api/v1/find?q= with the owner token; POST /api/v1/index to add an image.</p>`));
    r.get('/read', (req, res) => toolPage(req, res, 'Read a receipt', 'Local Tesseract extracts store, line items and total; a routed fallback is optional.', html`<p class="vi-fine">Food calls POST /api/v1/receipt with the image and optional fallback=true. For plain text, use POST /api/v1/ocr.</p>`));
    r.get('/watch', (req, res) => toolPage(req, res, 'Watch a still', 'Detect selected objects or a scene change in an owner-supplied camera still.', html`<p class="vi-fine">Cam calls POST /api/v1/watch with the owner token, image and classes. Send previous_image for scene change.</p>`));

    // ── Ask ──────────────────────────────────────────────────
    r.get('/ask', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'Ask a picture',
        description: 'Upload an image or paste a public image URL and ask what it shows: describe, read, translate, identify or count.',
        body: raw(views.ask({ signedIn: Boolean(signedIn(req)), ai: ai.enabled })),
    }));
    r.post('/ask', uploadMiddleware, async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Ask a picture', body: raw(views.signIn({ title: 'Ask a picture', text: 'An answer saved to your account needs an OpenVibe sign-in.', next: '/ask' })) }, 401);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const b = bodyOf(req);
        try {
            const image = await imageOf(req);
            const out = await vision.ask({
                requester: `user:${req.viewer.subject}`, subject: req.viewer.subject, image,
                task: b.task || 'ask', question: b.question || b.q || '', mode: b.mode || 'auto', lang: b.lang, model: b.model,
            });
            return res.redirect(303, `/a/${encodeURIComponent(out.id)}`);
        } catch (err) {
            return page(req, res, { title: 'Ask a picture', body: raw(views.ask({ signedIn: true, ai: ai.enabled, problem: err instanceof VisionError ? err.detail : 'That request could not be answered.', values: { question: b.question || b.q || '', task: b.task || 'ask', mode: b.mode || 'auto', image_url: b.image_url || '' } })) }, err instanceof VisionError ? err.status : 500);
        }
    });

    // ── OCR ──────────────────────────────────────────────────
    r.get('/ocr', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'Read text from a picture',
        description: 'Local Tesseract OCR first: read a receipt, a sign or a screenshot on this host, with no model call.',
        body: raw(views.ocr({ signedIn: Boolean(signedIn(req)), ai: ai.enabled })),
    }));
    r.post('/ocr', uploadMiddleware, async (req, res) => {
        if (signedIn(req) && !sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const b = bodyOf(req);
        const fallback = b.fallback === '1' || b.fallback === 'true' || b.fallback === 'on';
        if (!signedIn(req) && fallback) return page(req, res, { title: 'Read text from a picture', body: raw(views.ocr({ signedIn: false, ai: ai.enabled, problem: 'The AI fallback needs a signed-in account. Local OCR runs without one.' })) }, 401);
        try {
            const image = await imageOf(req);
            const out = await vision.ocr({
                requester: signedIn(req) ? `user:${req.viewer.subject}` : 'anonymous', subject: signedIn(req) ? req.viewer.subject : null,
                image, lang: b.lang, fallback: signedIn(req) && fallback, model: b.model,
            });
            if (signedIn(req)) return res.redirect(303, `/a/${encodeURIComponent(out.id)}`);
            return page(req, res, { title: 'Read text from a picture', body: raw(views.ocr({ signedIn: false, ai: ai.enabled, result: out })) });
        } catch (err) {
            return page(req, res, { title: 'Read text from a picture', body: raw(views.ocr({ signedIn: Boolean(signedIn(req)), ai: ai.enabled, problem: err instanceof VisionError ? err.detail : 'That image could not be read.' })) }, err instanceof VisionError ? err.status : 500);
        }
    });

    // ── Compare ──────────────────────────────────────────────
    r.get('/compare', async (req, res) => {
        let models = [];
        try { models = ai.enabled ? await ai.offeredModels() : []; } catch { models = []; }
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE, title: 'Compare models side by side',
            description: 'Run the same image through the local OCR reader and through OpenVibe.AI, and compare the answer, cost and latency side by side.',
            body: raw(views.compare({ signedIn: Boolean(signedIn(req)), ai: ai.enabled, models, configured: config.ai.models })),
        });
    });
    r.post('/compare', uploadMiddleware, async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Compare models', body: raw(views.signIn({ title: 'Compare models', text: 'A compare spends an AI run, so it needs an OpenVibe account.', next: '/compare' })) }, 401);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const b = bodyOf(req);
        const models = b.models == null ? [] : (Array.isArray(b.models) ? b.models : [b.models]);
        try {
            const image = await imageOf(req);
            const out = await vision.compare({
                requester: `user:${req.viewer.subject}`, subject: req.viewer.subject, image,
                task: b.task || 'ask', question: b.question || b.q || '', models, lang: b.lang,
            });
            return res.redirect(303, `/a/${encodeURIComponent(out.id)}`);
        } catch (err) {
            return page(req, res, { title: 'Compare models', body: raw(views.compare({ signedIn: true, ai: ai.enabled, models: [], configured: config.ai.models, problem: err instanceof VisionError ? err.detail : 'That compare could not run.', values: { question: b.question || '', task: b.task || 'ask', image_url: b.image_url || '' } })) }, err instanceof VisionError ? err.status : 500);
        }
    });

    // ── UI check ─────────────────────────────────────────────
    r.get('/ui-check', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'Check a page for UI faults',
        description: 'Overflow, cut-off text, low contrast, overlap and layering faults from HTML, a URL or a screenshot. The API Design\'s Arena calls.',
        body: raw(views.uiCheck({ signedIn: Boolean(signedIn(req)) })),
    }));
    r.post('/ui-check', uploadMiddleware, async (req, res) => {
        if (signedIn(req) && !sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const b = bodyOf(req);
        const viewport = viewportOf(req);
        try {
            let out; let image = null; let source = 'html';
            if (req.file || b.image || b.image_url) {
                image = await imageOf(req); source = 'screenshot';
                out = await uiCheck({ imageBuffer: image.buffer, viewport, ocr, maxFindings: config.ui.maxFindings });
            } else if (b.html) {
                if (Buffer.byteLength(String(b.html), 'utf8') > config.ui.maxHtmlBytes) throw new VisionError(413, 'vision.ui_too_large', 'that HTML is larger than the UI check limit');
                out = await uiCheck({ html: String(b.html), viewport, maxFindings: config.ui.maxFindings });
            } else if (b.url) {
                source = 'url';
                out = await uiCheck({ url: String(b.url), viewport, config, fetchImpl, maxFindings: config.ui.maxFindings });
            } else {
                throw new VisionError(400, 'vision.invalid', 'send HTML, a URL or a screenshot');
            }
            const saved = signedIn(req) ? await store.saveUiCheck({
                subject: req.viewer.subject, requester: `user:${req.viewer.subject}`, source: out.source,
                url: out.url || null, imageSha256: image ? image.sha256 : null, viewport: out.viewport,
                engine: out.engine, findings: out.findings, summary: out,
            }) : null;
            if (saved) return res.redirect(303, `/ui/${encodeURIComponent(saved.id)}`);
            return page(req, res, { title: 'Check a page for UI faults', body: raw(views.uiCheck({ signedIn: false, result: out })) });
        } catch (err) {
            return page(req, res, { title: 'Check a page for UI faults', body: raw(views.uiCheck({ signedIn: Boolean(signedIn(req)), problem: err instanceof VisionError ? err.detail : (err && err.code ? err.message : 'That page could not be checked.'), values: { html: b.html || '', url: b.url || '', viewport_w: viewport.w, viewport_h: viewport.h } })) }, err instanceof VisionError ? err.status : 400);
        }
    });

    // ── One saved answer / UI check ──────────────────────────
    r.get('/a/:id', async (req, res) => {
        const row = await store.answerById(String(req.params.id || ''));
        if (!row) return notFound(req, res);
        const owner = await store.answerSubject(row.id);
        const mine = Boolean(signedIn(req) && owner && req.viewer.subject === owner);
        if (!mine && !staffViewer(req)) return notFound(req, res);
        return page(req, res, { title: row.task === 'ocr' ? 'An OCR answer' : 'An answer', body: raw(views.answer({ a: row, mine })), cache: null });
    });
    r.get('/ui/:id', async (req, res) => {
        const row = await store.uiCheckById(String(req.params.id || ''));
        if (!row) return notFound(req, res);
        const owner = await store.uiCheckSubject(row.id);
        const mine = Boolean(signedIn(req) && owner && req.viewer.subject === owner);
        if (!mine && !staffViewer(req)) return notFound(req, res);
        return page(req, res, { title: 'A UI check', body: raw(views.uiCheckResult({ c: row, mine })), cache: null });
    });

    // ── Developers ───────────────────────────────────────────
    r.get('/developers', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'The OpenVibe.Vision API',
        description: 'Ask, OCR, compare and the UI check as JSON. Design\'s Arena calls POST /api/v1/ui-check with vision.ui.check.',
        jsonLd: [seo.jsonLd.webPage({ name: 'The OpenVibe.Vision API', url: `${base()}/developers`, description: 'Ask a picture, OCR, compare and the UI check as JSON.', siteUrl: base() })],
        body: raw(views.developers({ ai: ai.enabled, models: config.ai.models })),
    }));

    r.use(createDiscoveryRoutes(ctx));

    function notFound(req, res) {
        return page(req, res, { title: 'Not found', body: raw(views.notFound()) }, 404);
    }
    return r;
}

module.exports = { createPageRoutes };
