'use strict';
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { loadImage } = require('../vision/images');
const { VisionError } = require('../vision/service');

function createFaceApi({ config, principal, faces, faceLibraries, fetchImpl }) {
    const r = asyncRouter();
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.images.maxMb * 1024 * 1024, files: 1 } });
    const imageField = (req, res, next) => upload.single('image')(req, res, next);
    r.use(express.json({ limit: `${Math.ceil(config.images.maxMb * 1.5) + 2}mb` }));
    r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    r.use(principal.middleware);
    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    const person = (req, res, next) => {
        if (req.principal.kind !== 'user') return problem(res, 401, 'faces.person_required', 'Sign in with your own Network account.');
        if (req.method !== 'GET' && req.principal.viaSession && !sameOrigin(req, config.baseUrl)) return problem(res, 403, 'vision.cross_site', 'This signed-in change must come from Vision.');
        return next();
    };
    async function image(req) {
        const b = req.body || {};
        return loadImage({ file: req.file && req.file.buffer, image: b.image, imageUrl: b.image_url, config, fetchImpl });
    }
    const run = (fn, status = 200) => async (req, res) => {
        try { return res.status(status).json(await fn(req, res)); }
        catch (err) {
            if (err instanceof VisionError) return problem(res, err.status, err.code, err.detail);
            if (err && /^image\./.test(err.code || '')) return problem(res, err.code === 'image.too_large' ? 413 : 400, `vision.${err.code.replace('.', '_')}`, err.message);
            throw err;
        }
    };
    const privacyLimit = rateLimit({
        windowMs: 60_000, limit: Number(process.env.VISION_FACE_PRIVACY_RATE_LIMIT_PER_MIN) || 30,
        standardHeaders: true, legacyHeaders: false,
        handler: (req, res) => problem(res, 429, 'vision.rate_limited', 'too many face privacy requests from this address; retry shortly'),
    });
    r.post('/detect', privacyLimit, principal.optional('vision.face.detect', { allowAnonymous: true }), imageField, run(async (req) => faces.detect((await image(req)).buffer)));
    r.post('/blur', privacyLimit, principal.optional('vision.face.blur', { allowAnonymous: true }), imageField, async (req, res) => {
        try {
            const out = await faces.blur((await image(req)).buffer);
            res.set('X-Faces-Blurred', String(out.count));
            return res.type('image/png').send(out.buffer);
        } catch (err) {
            if (err instanceof VisionError) return problem(res, err.status, err.code, err.detail);
            if (err && /^image\./.test(err.code || '')) return problem(res, err.code === 'image.too_large' ? 413 : 400, `vision.${err.code.replace('.', '_')}`, err.message);
            throw err;
        }
    });
    r.get('/consents/text', (_req, res) => res.json(faces.TEXT));
    r.get('/consents', person, run((req) => faces.listConsents(req.principal.subject)));
    r.post('/consents/:feature', person, run((req) => faces.consent(req.principal.subject, req.params.feature, {
        signedName: req.body?.signed_name, textVersion: req.body?.text_version, channel: req.body?.channel,
        adult: req.body?.adult, region: req.body?.region,
    })));
    r.delete('/consents/:feature', person, run((req) => faces.revoke(req.principal.subject, req.params.feature, req.body?.channel || req.query.channel)));
    r.post('/enrol/:feature', person, imageField, run(async (req) => faces.enrol(req.principal.subject, req.params.feature, (await image(req)).buffer, req.body?.channel)));
    r.post('/verify', person, imageField, run(async (req) => faces.verify(req.principal.subject, (await image(req)).buffer)));
    r.post('/media', person, imageField, run(async (req) => { const im = await image(req); return faces.upload(req.principal.subject, im.buffer, im.mime); }));
    r.get('/media/:id', person, async (req, res) => {
        try { const im = await faces.media(req.principal.subject, req.params.id); return res.type(im.mime).send(im.buffer); }
        catch (err) { if (err instanceof VisionError) return problem(res, err.status, err.code, err.detail); throw err; }
    });
    r.post('/find', person, run((req) => faces.find(req.principal.subject)));
    r.get('/cast/tags', person, run((req) => faces.tags(req.principal.subject)));
    r.post('/cast/match', imageField, async (req, res, next) => {
        const p = req.principal, channel = req.body?.channel;
        if (p.kind !== 'service' || p.sub !== 'svc:live' || !principal.granted(p, 'vision.face.cast.match') || p.claims.channel_id !== channel) {
            return problem(res, 403, 'faces.live_grant_required', 'A Live token scoped to this channel is required.');
        }
        return next();
    }, run(async (req) => faces.castMatch(req.body.channel, (await image(req)).buffer, req.body.media_ref)));
    // ── F1: a camera owner's own familiar-face library ─────
    // The camera's region decides the mode; strict mode names a person without a template until their consent is
    // in Network's registry (or they accept the private link). A match reads only the library it names.
    r.get('/libraries', person, run((req) => faceLibraries.list(req.principal.subject).then((libraries) => ({ count: libraries.length, libraries }))));
    r.post('/libraries', person, run((req) => faceLibraries.create(req.principal.subject, req.body || {}), 201));
    r.get('/libraries/:id', person, run((req) => faceLibraries.get(req.principal.subject, req.params.id)));
    r.patch('/libraries/:id', person, run((req) => faceLibraries.patch(req.principal.subject, req.params.id, req.body || {})));
    r.delete('/libraries/:id', person, run((req) => faceLibraries.remove(req.principal.subject, req.params.id)));
    r.post('/libraries/:id/enroll', person, imageField, run(async (req) => {
        const im = await image(req);
        return faceLibraries.enroll(req.principal.subject, req.params.id, im.buffer, { ...(req.body || {}), image_mime: im.mime });
    }));
    r.post('/libraries/:id/match', person, imageField, run(async (req) => faceLibraries.match(req.principal.subject, req.params.id, (await image(req)).buffer)));
    r.get('/libraries/:id/people', person, run((req) => faceLibraries.people(req.principal.subject, req.params.id)));
    r.patch('/libraries/:id/people/:personId', person, run((req) => faceLibraries.patchPerson(req.principal.subject, req.params.id, req.params.personId, req.body || {})));
    r.delete('/libraries/:id/people/:personId', person, run((req) => faceLibraries.removePerson(req.principal.subject, req.params.id, req.params.personId)));
    r.post('/libraries/:id/people/:personId/request', person, run((req) => faceLibraries.requestAgain(req.principal.subject, req.params.id, req.params.personId)));
    r.post('/libraries/:id/consent-check', person, run((req) => faceLibraries.checkPending(req.principal.subject, req.params.id)));
    r.post('/consent-requests/:token/accept', person, run((req) => faceLibraries.acceptRequest(req.principal.subject, req.params.token, req.body || {})));
    r.post('/consent-requests/:token/deny', person, run((req) => faceLibraries.denyRequest(req.principal.subject, req.params.token)));
    r.post('/library/cluster', person, run((req) => faces.cluster(req.principal.subject, req.body?.region)));
    r.get('/library/groups', person, run((req) => faces.groups(req.principal.subject)));
    r.post('/library/correct', person, run((req) => faces.correction(req.principal.subject, req.body?.action, req.body?.ids)));
    // multer errors are translated without exposing file contents.
    r.use((err, req, res, next) => err && err.code === 'LIMIT_FILE_SIZE'
        ? problem(res, 413, 'vision.image_too_large', 'Image exceeds the configured size limit.') : next(err));
    return r;
}
module.exports = { createFaceApi };
