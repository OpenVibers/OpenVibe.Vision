'use strict';
/**
 * Faces with consent (§5.8b), with a fake ONNX model: no weights and no inference in the test.
 *
 * Proves the rules the plan makes non-negotiable: detect/blur need no identity, every matching purpose has its own
 * signed consent, templates and uploads are AES-GCM ciphertext at rest, a cast channel reads only its own roster,
 * library grouping is region-gated and unknown faces stay unlabelled, opt-out erases at once, the retention job
 * expires data, and ADR-033 export/erasure include every face row.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const { cosine } = require('../server/vision/faces-model');
const { keyOf, open } = require('../server/vision/faces');

process.env.VISION_FACE_PRIVACY_RATE_LIMIT_PER_MIN = '100000';

const KEY = Buffer.alloc(32, 7).toString('base64');
const FACE = { x: 20, y: 20, width: 80, height: 80, score: 0.99, landmarks: [[40, 50], [80, 50], [60, 70], [45, 90], [75, 90]] };

/** A stand-in for YuNet/SFace: faces and vectors are injected per call, so no image is ever really inferred. */
function fakeFacesModel() {
    const state = { faces: [{ ...FACE }], vector: [1, 0, 0, 0], vectors: null, at: 0, blurred: null, detectCalls: 0 };
    const next = () => {
        const v = state.vectors ? state.vectors[state.at++ % state.vectors.length] : state.vector;
        return Array.from(v);
    };
    return {
        state,
        available: () => ({ yunet: true, sface: true }),
        detect: async () => { state.detectCalls++; return state.faces.map((f) => ({ ...f, landmarks: f.landmarks.map((p) => p.slice()) })); },
        embed: async () => next(),
        blur: async (_buffer, faces) => { state.blurred = faces.length; return Buffer.from(`BLURRED:${faces.length}`, 'utf8'); },
        cosine,
    };
}

function liveToken(t, channel) {
    const now = Math.floor(Date.now() / 1000);
    return t.network.signJwt({
        iss: t.network.issuer(), sub: 'svc:live', actor_type: 'service', aud: ['openvibe.vision'],
        cap: ['vision.face.cast.match'], channel_id: channel, iat: now, exp: now + 300, jti: crypto.randomUUID(),
    });
}

(async () => {
    const model = fakeFacesModel();
    const t = await boot({
        env: { VISION_FACE_KEY: KEY, VISION_FACE_LIBRARY_REGIONS: 'US-IL, US-TX' },
        facesModel: model,
    });
    const ana = t.network.addUser('ana');
    const bo = t.network.addUser('bo');
    const cy = t.network.addUser('cy');
    const dee = t.network.addUser('dee');
    const eve = t.network.addUser('eve');
    const png = await t.textImage('A FACE');
    const db = t.ctx.s.db;

    const oneFace = () => { model.state.faces = [{ ...FACE }]; };
    const vector = (v) => { model.state.vector = v; model.state.vectors = null; model.state.at = 0; };
    const consent = (as, feature, extra = {}) => t.get(`/api/v1/faces/consents/${feature}`, {
        as, json: { signed_name: 'Test Person', text_version: t.ctx.faces.TEXT[feature].version, ...extra },
    });
    const enrol = (as, feature, fields = {}) => t.get(`/api/v1/faces/enrol/${feature}`, { as, multipart: { fields, image: png } });
    const upload = (as) => t.get('/api/v1/faces/media', { as, multipart: { image: png } });
    const verify = (as) => t.get('/api/v1/faces/verify', { as, multipart: { image: png } });
    const count = async (table, subject) => Number(await db.value(`SELECT COUNT(*)::int AS n FROM ${table} WHERE subject=$1`, [subject]));

    try {
        await check('detect and blur are open privacy tools; they store no template and return no identity', async () => {
            oneFace();
            const detect = await t.get('/api/v1/faces/detect', { multipart: { image: png } });
            assert.strictEqual(detect.status, 200, detect.text);
            assert.strictEqual(detect.json().count, 1);
            assert.strictEqual(detect.json().boxes.length, 1);
            assert.deepStrictEqual(Object.keys(detect.json()).sort(), ['boxes', 'count']);
            assert.strictEqual(await count('face_templates', ana.subject), 0);

            const blur = await t.get('/api/v1/faces/blur', { multipart: { image: png } });
            assert.strictEqual(blur.status, 200, blur.text);
            assert.match(blur.headers.get('content-type'), /^image\/png/);
            assert.strictEqual(blur.headers.get('x-faces-blurred'), '1');
            assert.strictEqual(blur.buffer.toString('utf8'), 'BLURRED:1');
            assert.strictEqual(model.state.blurred, 1);
        });

        await check('every matching purpose refuses an anonymous caller or a person without its consent', async () => {
            vector([1, 0, 0, 0]);
            assert.strictEqual((await verify(ana)).status, 403);
            assert.strictEqual((await verify(ana)).json().code, 'faces.consent_required');
            assert.strictEqual((await t.get('/api/v1/faces/find', { as: ana, json: {} })).status, 403);
            assert.strictEqual((await enrol(ana, 'verify')).status, 403);
            assert.strictEqual((await enrol(ana, 'cast', { channel: 'live:one' })).status, 403);
            assert.strictEqual((await upload(ana)).status, 403);
            assert.strictEqual((await t.get('/api/v1/faces/library/cluster', { as: ana, json: { region: 'US-IL' } })).status, 403);
            assert.strictEqual((await t.get('/api/v1/faces/library/groups', { as: ana })).status, 403);
            assert.strictEqual((await t.get('/api/v1/faces/library/correct', { as: ana, json: { action: 'exclude', ids: ['fcl_x'] } })).status, 403);
            const noTags = await t.get('/api/v1/faces/cast/tags', { as: ana });
            assert.strictEqual(noTags.status, 200);
            assert.deepStrictEqual(noTags.json(), []);

            const anon = await t.get('/api/v1/faces/cast/match', { multipart: { fields: { channel: 'live:one', media_ref: 'media:a' }, image: png } });
            assert.strictEqual(anon.status, 403);
            assert.strictEqual(anon.json().code, 'faces.live_grant_required');
            assert.strictEqual((await t.get('/api/v1/faces/consents')).status, 401);
            const service = t.network.serviceToken({ sub: 'svc:live', cap: ['vision.face.cast.match'] });
            assert.strictEqual((await t.get('/api/v1/faces/verify', { bearer: service, multipart: { image: png } })).status, 401);
        });

        await check('a consent records the feature, text version, signature and server time', async () => {
            const texts = await t.get('/api/v1/faces/consents/text');
            assert.strictEqual(texts.status, 200);
            assert.deepStrictEqual(Object.keys(texts.json()).sort(), ['cast', 'find', 'library', 'verify']);

            const wrong = await t.get('/api/v1/faces/consents/verify', { as: ana, json: { signed_name: 'Ana', text_version: 'old' } });
            assert.strictEqual(wrong.status, 400);
            assert.strictEqual(wrong.json().code, 'faces.signature_required');
            assert.strictEqual((await t.get('/api/v1/faces/consents/verify', { as: ana, json: { text_version: t.ctx.faces.TEXT.verify.version } })).status, 400);

            const castNoAdult = await consent(ana, 'cast', { channel: 'live:one' });
            assert.strictEqual(castNoAdult.status, 400);
            assert.strictEqual(castNoAdult.json().code, 'faces.adult_required');
            const region = await consent(ana, 'library', { region: 'FR' });
            assert.strictEqual(region.status, 403);
            assert.strictEqual(region.json().code, 'faces.region_disabled');

            const verify = await consent(ana, 'verify');
            assert.strictEqual(verify.status, 200, verify.text);
            assert.strictEqual(verify.json().feature, 'verify');
            assert.strictEqual(verify.json().text_version, t.ctx.faces.TEXT.verify.version);
            assert.ok(Date.parse(verify.json().granted_at));
            const row = await db.maybe('SELECT * FROM face_consents WHERE subject=$1 AND feature=$2 AND revoked_at IS NULL', [ana.subject, 'verify']);
            assert.strictEqual(row.text_version, t.ctx.faces.TEXT.verify.version);
            assert.strictEqual(row.signature, 'Test Person');
            assert.strictEqual(row.revoked_at, null);
            assert.ok(Date.parse(row.granted_at));
            const waitingForEnrolment = await t.get('/api/v1/faces/verify', { as: ana, multipart: { image: png } });
            assert.strictEqual(waitingForEnrolment.status, 403);
            assert.strictEqual(waitingForEnrolment.json().code, 'faces.consent_required');
            assert.strictEqual(waitingForEnrolment.json().detail, 'Enable verify consent first.');

            assert.strictEqual((await consent(ana, 'find')).status, 200);
            assert.strictEqual((await consent(ana, 'cast', { channel: 'live:one', adult: true })).status, 200);
            assert.strictEqual((await consent(bo, 'cast', { channel: 'live:two', adult: true })).status, 200);

            const crossSite = await t.get('/api/v1/faces/consents/verify', { as: ana, origin: 'https://evil.example', json: { signed_name: 'Ana', text_version: t.ctx.faces.TEXT.verify.version } });
            assert.strictEqual(crossSite.status, 403);
            assert.strictEqual(crossSite.json().code, 'vision.cross_site');
        });

        await check('enrolment needs exactly one face and seals the template with AES-GCM', async () => {
            model.state.faces = [];
            assert.strictEqual((await enrol(ana, 'verify')).status, 422);
            oneFace();
            model.state.faces = [{ ...FACE }, { ...FACE, x: 200 }];
            assert.strictEqual((await enrol(ana, 'verify')).status, 422);
            oneFace();

            vector([1, 0, 0, 0]);
            const out = await enrol(ana, 'verify');
            assert.strictEqual(out.status, 200, out.text);
            assert.strictEqual(out.json().enrolled, true);
            assert.strictEqual(out.json().liveness, 'not_checked');
            const row = await db.maybe('SELECT ciphertext FROM face_templates WHERE subject=$1 AND feature=$2', [ana.subject, 'verify']);
            assert.ok(row && row.ciphertext);
            assert.ok(!row.ciphertext.includes('1,0,0,0'), 'the vector is not plaintext');
            assert.deepStrictEqual(open(keyOf(KEY), row.ciphertext), [1, 0, 0, 0]);
            assert.deepStrictEqual(keyOf('k'.repeat(32)), Buffer.from('k'.repeat(32)));
            assert.deepStrictEqual(keyOf('ab'.repeat(32)), Buffer.from('ab'.repeat(32), 'hex'));

            vector([0, 1, 0, 0]);
            assert.strictEqual((await enrol(ana, 'find')).status, 200);
            vector([1, 0, 0, 0]);
            assert.strictEqual((await enrol(ana, 'cast', { channel: 'live:one' })).status, 200);
            assert.strictEqual((await enrol(bo, 'cast', { channel: 'live:two' })).status, 200);
        });

        await check('verify answers a score for the caller\'s own template and never an identity', async () => {
            vector([1, 0, 0, 0]);
            const yes = await verify(ana);
            assert.strictEqual(yes.status, 200, yes.text);
            const b = yes.json();
            assert.ok(b.score > 0.99);
            assert.strictEqual(b.match, true);
            assert.strictEqual(b.threshold, t.config.faces.threshold);
            assert.strictEqual(b.liveness, 'not_checked');
            assert.deepStrictEqual(Object.keys(b).sort(), ['liveness', 'match', 'score', 'threshold']);
            assert.ok(!yes.text.includes(ana.subject));
            assert.ok(!yes.text.includes(bo.subject));

            vector([0, 1, 0, 0]);
            const no = await verify(ana);
            assert.strictEqual(no.status, 200, no.text);
            assert.strictEqual(no.json().match, false);
            assert.ok(no.json().score < t.config.faces.threshold);
            assert.strictEqual((await verify(bo)).status, 403);
        });

        await check('self search reads only the caller\'s own encrypted upload and returns private links', async () => {
            vector([0, 1, 0, 0]);
            assert.strictEqual((await consent(bo, 'find')).status, 200);
            assert.strictEqual((await enrol(bo, 'find')).status, 200);
            const up = await upload(ana);
            assert.strictEqual(up.status, 200, up.text);
            assert.match(up.json().private_link, /^\/api\/v1\/faces\/media\/fme_/);
            assert.strictEqual(up.json().face_count, 1);
            const id = up.json().private_link.split('/').pop();
            const row = await db.maybe('SELECT image_ciphertext,vectors_ciphertext FROM face_media WHERE id=$1', [id]);
            assert.ok(!row.image_ciphertext.includes(png.toString('base64')));
            assert.deepStrictEqual(open(keyOf(KEY), row.image_ciphertext, true), png);
            assert.deepStrictEqual(open(keyOf(KEY), row.vectors_ciphertext), [[0, 1, 0, 0]]);

            const own = await t.get(`/api/v1/faces/media/${id}`, { as: ana });
            assert.strictEqual(own.status, 200);
            assert.deepStrictEqual(own.buffer, png);
            assert.strictEqual((await t.get(`/api/v1/faces/media/${id}`, { as: bo })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/faces/media/${id}`, { as: cy })).status, 404, 'ownership is checked before consent');
            assert.strictEqual((await t.get(`/api/v1/faces/media/${id}`)).status, 401);

            vector([0, 1, 0, 0]);
            const found = await t.get('/api/v1/faces/find', { as: ana, json: {} });
            assert.strictEqual(found.status, 200, found.text);
            assert.strictEqual(found.json().results.length, 1);
            assert.strictEqual(found.json().results[0].private_link, `/api/v1/faces/media/${id}`);
            assert.ok(!found.text.includes(ana.subject));
            assert.ok(!found.text.includes(bo.subject));
        });

        await check('opting out of self search deletes its template and stored uploads at once', async () => {
            await vector([0, 1, 0, 0]);
            const off = await t.get('/api/v1/faces/consents/find', { method: 'DELETE', as: ana });
            assert.strictEqual(off.status, 200, off.text);
            assert.strictEqual(off.json().erased, true);
            assert.strictEqual(await count('face_templates', ana.subject) >= 1, true, 'verify template remains');
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE subject=$1 AND feature='find'", [ana.subject])), 0);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_media WHERE subject=$1", [ana.subject])), 0);
            assert.strictEqual((await t.get('/api/v1/faces/find', { as: ana, json: {} })).status, 403);
        });

        await check('library grouping is region-gated, unlabelled and correctable; turning it off erases', async () => {
            assert.strictEqual((await consent(ana, 'library', { region: 'US-IL' })).status, 200);
            assert.strictEqual((await t.get('/api/v1/faces/library/cluster', { as: ana, json: { region: 'FR' } })).status, 403);

            model.state.faces = [{ ...FACE }, { ...FACE, x: 200 }];
            model.state.vector = [0, 0, 0, 1];
            model.state.vectors = [[1, 0, 0, 0], [0, 1, 0, 0]];
            model.state.at = 0;
            const first = await upload(ana);
            assert.strictEqual(first.status, 200, first.text);
            assert.strictEqual(first.json().face_count, 2);

            oneFace();
            vector([1, 0, 0, 0]);
            const second = await upload(ana);
            assert.strictEqual(second.status, 200, second.text);

            const clustered = await t.get('/api/v1/faces/library/cluster', { as: ana, json: { region: 'US-IL' } });
            assert.strictEqual(clustered.status, 200, clustered.text);
            const groups = clustered.json();
            assert.strictEqual(groups.length, 3);
            assert.ok(groups.every((g) => g.label === null));
            assert.ok(groups.every((g) => !('subject' in g)));
            assert.strictEqual(new Set(groups.map((g) => g.group_id)).size, 2);

            const [a, b] = groups;
            const excluded = await t.get('/api/v1/faces/library/correct', { as: ana, json: { action: 'exclude', ids: [a.id] } });
            assert.strictEqual(excluded.status, 200, excluded.text);
            assert.strictEqual(excluded.json().updated, 1);
            assert.strictEqual((await db.maybe('SELECT excluded FROM face_clusters WHERE id=$1', [a.id])).excluded, true);

            const open = groups.filter((g) => g.id !== a.id);
            assert.ok(open.length >= 2);
            const merged = await t.get('/api/v1/faces/library/correct', { as: ana, json: { action: 'merge', ids: [open[0].id, open[1].id] } });
            assert.strictEqual(merged.status, 200, merged.text);
            const same = await db.many('SELECT group_id FROM face_clusters WHERE id=ANY($1::text[])', [[open[0].id, open[1].id]]);
            assert.strictEqual(new Set(same.map((r) => r.group_id)).size, 1);

            const split = await t.get('/api/v1/faces/library/correct', { as: ana, json: { action: 'split', ids: [b.id] } });
            assert.strictEqual(split.status, 200, split.text);
            const before = await db.maybe('SELECT group_id FROM face_clusters WHERE id=$1', [b.id]);
            assert.ok(before.group_id);

            const off = await t.get('/api/v1/faces/consents/library', { method: 'DELETE', as: ana });
            assert.strictEqual(off.status, 200, off.text);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_clusters WHERE subject=$1", [ana.subject])), 0);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_media WHERE subject=$1", [ana.subject])), 0);
            assert.strictEqual((await t.get('/api/v1/faces/library/groups', { as: ana })).status, 403);
        });

        await check('a cast channel matches only its own roster; revocation removes matches and past tags', async () => {
            vector([1, 0, 0, 0]);
            const one = liveToken(t, 'live:one');
            const matchOne = await t.get('/api/v1/faces/cast/match', { bearer: one, multipart: { fields: { channel: 'live:one', media_ref: 'media:stream-1' }, image: png } });
            assert.strictEqual(matchOne.status, 200, matchOne.text);
            assert.strictEqual(matchOne.json().matches.length, 1);
            assert.strictEqual(matchOne.json().matches[0].subject, ana.subject);
            assert.ok(!matchOne.text.includes(bo.subject));
            assert.strictEqual(matchOne.json().liveness, 'not_checked');

            const two = liveToken(t, 'live:two');
            const matchTwo = await t.get('/api/v1/faces/cast/match', { bearer: two, multipart: { fields: { channel: 'live:two', media_ref: 'media:stream-2' }, image: png } });
            assert.strictEqual(matchTwo.status, 200, matchTwo.text);
            assert.strictEqual(matchTwo.json().matches.length, 1);
            assert.strictEqual(matchTwo.json().matches[0].subject, bo.subject);
            assert.ok(!matchTwo.text.includes(ana.subject));

            const wrong = await t.get('/api/v1/faces/cast/match', { bearer: one, multipart: { fields: { channel: 'live:two', media_ref: 'media:stream-2' }, image: png } });
            assert.strictEqual(wrong.status, 403);

            const tags = await t.get('/api/v1/faces/cast/tags', { as: ana });
            assert.strictEqual(tags.status, 200);
            assert.strictEqual(tags.json().length, 1);
            assert.strictEqual(tags.json()[0].channel, 'live:one');
            assert.ok(!tags.text.includes(bo.subject));

            const off = await t.get('/api/v1/faces/consents/cast', { method: 'DELETE', as: ana, json: { channel: 'live:one' } });
            assert.strictEqual(off.status, 200, off.text);
            assert.strictEqual((await t.get('/api/v1/faces/cast/tags', { as: ana })).json().length, 0);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_tags WHERE subject=$1", [ana.subject])), 0);
            const after = await t.get('/api/v1/faces/cast/match', { bearer: one, multipart: { fields: { channel: 'live:one', media_ref: 'media:stream-1' }, image: png } });
            assert.strictEqual(after.status, 200);
            assert.deepStrictEqual(after.json().matches, []);
            const still = await t.get('/api/v1/faces/cast/match', { bearer: two, multipart: { fields: { channel: 'live:two', media_ref: 'media:stream-2' }, image: png } });
            assert.strictEqual(still.json().matches.length, 1, 'the other channel is unaffected');
            await t.get('/api/v1/faces/consents/cast', { method: 'DELETE', as: bo, json: { channel: 'live:two' } });
        });

        await check('the retention job erases expired templates and old consent records, not recent ones', async () => {
            vector([1, 0, 0, 0]);
            assert.strictEqual((await consent(cy, 'verify')).status, 200);
            assert.strictEqual((await enrol(cy, 'verify')).status, 200);
            await db.exec("UPDATE face_consents SET last_used_at = now() - interval '4 years' WHERE subject=$1 AND feature='verify'", [cy.subject]);
            const first = await t.ctx.faces.retention();
            assert.ok(first.expired >= 1);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE subject=$1 AND feature='verify'", [cy.subject])), 0);
            assert.ok((await db.maybe('SELECT revoked_at FROM face_consents WHERE subject=$1 AND feature=$2', [cy.subject, 'verify'])).revoked_at);
            await db.exec("UPDATE face_consents SET purpose_ends_at = now() - interval '2 years' WHERE subject=$1 AND feature='verify' AND revoked_at IS NOT NULL", [cy.subject]);
            const second = await t.ctx.faces.retention();
            assert.ok(second.consent_records_deleted >= 1);
            assert.strictEqual(await count('face_consents', cy.subject), 0);

            assert.strictEqual((await consent(eve, 'verify')).status, 200);
            assert.strictEqual((await enrol(eve, 'verify')).status, 200);
            await db.exec("UPDATE face_consents SET last_used_at = now() - interval '2 years' WHERE subject=$1 AND feature='verify'", [eve.subject]);
            await t.ctx.faces.retention();
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE subject=$1 AND feature='verify'", [eve.subject])), 1);
        });

        await check('/people and /privacy explain the consent model with plain vi- markup', async () => {
            const anon = await t.get('/people');
            assert.strictEqual(anon.status, 200);
            for (const id of ['vi-people', 'vi-verify', 'vi-find', 'vi-cast', 'vi-library']) assert.ok(anon.text.includes(`id="${id}"`), id);
            assert.match(anon.text, /Sign in with your Network account/);

            const signed = await t.get('/people', { as: ana });
            assert.strictEqual(signed.status, 200);
            assert.ok(signed.text.includes('/people/consent/verify'));
            assert.ok(signed.text.includes('/people/enrol/verify'));
            assert.match(signed.text, /role="switch"/);
            assert.match(signed.text, /name="text_version"/);
            assert.match(signed.text, /name="region"/);

            const privacy = await t.get('/people/privacy');
            assert.strictEqual(privacy.status, 200);
            assert.ok(privacy.text.includes('id="vi-privacy"'));
            assert.match(privacy.text, /three years/);
            assert.match(privacy.text, /What never happens/);
            assert.match(privacy.text, /not checked/);
            const policy = await t.get('/privacy');
            assert.strictEqual(policy.status, 200);
            assert.match(policy.text, /Privacy Policy/);

            const llms = await t.get('/llms.txt');
            assert.ok(!/No face recognition/i.test(llms.text));
            assert.match(llms.text, /separate consent/i);
            const home = await t.get('/');
            assert.ok(!/No face recognition/i.test(home.text));
            assert.ok(home.text.includes('/people'));
            assert.ok(home.text.includes('/people/privacy'));
        });

        await check('opting out of verification deletes its template at once', async () => {
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE subject=$1 AND feature='verify'", [ana.subject])), 1);
            const off = await t.get('/api/v1/faces/consents/verify', { method: 'DELETE', as: ana });
            assert.strictEqual(off.status, 200, off.text);
            assert.strictEqual(off.json().erased, true);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE subject=$1 AND feature='verify'", [ana.subject])), 0);
            assert.ok((await db.maybe('SELECT revoked_at FROM face_consents WHERE subject=$1 AND feature=$2', [ana.subject, 'verify'])).revoked_at);
            assert.strictEqual((await verify(ana)).status, 403);
        });

        await check('ADR-033 export and deletion include every face table', async () => {
            vector([1, 0, 0, 0]);
            assert.strictEqual((await consent(dee, 'verify')).status, 200);
            assert.strictEqual((await enrol(dee, 'verify')).status, 200);
            assert.strictEqual((await consent(dee, 'cast', { channel: 'live:dee', adult: true })).status, 200);
            assert.strictEqual((await enrol(dee, 'cast', { channel: 'live:dee' })).status, 200);
            assert.strictEqual((await consent(dee, 'library', { region: 'US-IL' })).status, 200);
            oneFace();
            vector([1, 0, 0, 0]);
            assert.strictEqual((await upload(dee)).status, 200);
            assert.strictEqual((await t.get('/api/v1/faces/library/cluster', { as: dee, json: { region: 'US-IL' } })).status, 200);
            const tag = await t.get('/api/v1/faces/cast/match', { bearer: liveToken(t, 'live:dee'), multipart: { fields: { channel: 'live:dee', media_ref: 'media:dee' }, image: png } });
            assert.strictEqual(tag.status, 200, tag.text);

            const part = await t.ctx.accountData.exportPart(dee.subject);
            const files = part.files.map((f) => f.name).sort();
            for (const file of ['face-clusters.json', 'face-consents.json', 'face-media.json', 'face-tags.json', 'face-templates.json']) assert.ok(files.includes(file), file);
            assert.ok(part.files.every((f) => f.content.every((row) => row.subject === dee.subject)));
            assert.ok(!JSON.stringify(part).includes(ana.subject));
            const template = part.files.find((f) => f.name === 'face-templates.json').content[0];
            assert.ok(!template.ciphertext.includes('1,0,0,0'));

            const erased = await t.ctx.accountData.erase([dee.subject]);
            for (const table of ['face_tags', 'face_clusters', 'face_media', 'face_templates', 'face_consents']) {
                assert.ok(erased.erased[table] >= 1, `${table} erased`);
                assert.strictEqual(await count(table, dee.subject), 0, `${table} empty`);
            }
            assert.ok((await count('face_consents', ana.subject)) >= 1);
        });

        await check('readiness reports a missing face key as degraded, and the rest of Vision stays ready', async () => {
            const ready = await t.get('/api/ready');
            assert.strictEqual(ready.status, 200, ready.text);
            assert.strictEqual(ready.json().checks.face_models.status, 'ok');

            const noKey = fakeFacesModel();
            const u = await boot({ env: { VISION_FACE_KEY: null, VISION_FACE_LIBRARY_REGIONS: 'US-IL' }, facesModel: noKey });
            try {
                const r = await u.get('/api/ready');
                assert.strictEqual(r.status, 200, r.text);
                assert.strictEqual(r.json().ready, true);
                assert.ok(r.json().degraded.includes('face_models'));
                assert.strictEqual(r.json().checks.face_models.status, 'fail');
                assert.match(r.text, /VISION_FACE_KEY/);
                const detect = await u.get('/api/v1/faces/detect', { multipart: { image: png } });
                assert.strictEqual(detect.status, 200, 'detect needs YuNet, not the key');
            } finally { await u.close(); }
        });
    } finally {
        await t.close();
    }
    done();
})();
