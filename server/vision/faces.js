'use strict';
const crypto = require('crypto');
const { VisionError } = require('./service');

const FEATURES = Object.freeze(['verify', 'find', 'cast', 'library']);
const TEXT = Object.freeze({
    verify: { version: 'face-verify-2026-10-28', text: 'Use my face template only to compare my own verification attempt with my Network account. A match alone never unlocks anything.' },
    find: { version: 'face-find-2026-10-28', text: 'Search only my own Vision uploads for my face. Results are private to me; no public face index is made.' },
    cast: { version: 'face-cast-2026-10-28', text: 'Match my face only within the named channel roster. I am an adult. Revoking this grant removes my tags.' },
    library: { version: 'face-library-2026-10-28', text: 'Cluster faces in my own Vision library. Other people in my uploads may be processed. Unknown faces stay unlabelled; I can exclude, merge, split or erase the groups.' },
});
const deny = (code, detail, status = 403) => { throw new VisionError(status, `faces.${code}`, detail); };
const scopeOf = (feature, channel) => {
    if (feature !== 'cast') return '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{1,119}$/.test(String(channel || ''))) deny('invalid_channel', 'Provide a named channel ID.', 400);
    return channel;
};
function keyOf(raw) {
    if (!raw) return null;
    const value = String(raw).trim();
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
    // A host may inject exactly 32 raw bytes instead of base64; both are an AES-256 key.
    const utf8 = Buffer.from(value, 'utf8');
    return utf8.length === 32 ? utf8 : null;
}
function seal(key, value) {
    const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
}
function open(key, value, asBuffer = false) {
    const bytes = Buffer.from(value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const data = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    return asBuffer ? data : JSON.parse(data.toString('utf8'));
}
function createFaces({ s, config, model }) {
    const db = s.db;
    const key = keyOf(config.faces.key);
    const timestamp = () => s.iso();
    function requireKey() { if (!key) deny('key_unavailable', 'Face encryption is not configured.', 503); }
    function requireModel(kind) {
        if (!model.available()[kind]) deny('model_unavailable', `${kind} weights are not installed.`, 503);
    }
    function regionAllowed(region) { return Boolean(region && config.faces.allowedRegions.includes(String(region).trim().toUpperCase())); }
    async function active(subject, feature, scope = '') {
        return db.maybe('SELECT * FROM face_consents WHERE subject=$1 AND feature=$2 AND scope=$3 AND revoked_at IS NULL', [subject, feature, scope]);
    }
    async function requireConsent(subject, feature, scope = '') {
        const row = await active(subject, feature, scope);
        if (!row) deny('consent_required', `Enable ${feature} consent first.`);
        return row;
    }
    async function consent(subject, feature, { signedName, textVersion, channel, adult, region } = {}) {
        if (!FEATURES.includes(feature)) deny('invalid_feature', 'Unknown face feature.', 400);
        const scope = scopeOf(feature, channel), at = timestamp();
        const existing = await active(subject, feature, scope);
        if (existing) return { feature, scope, text_version: existing.text_version, granted_at: existing.granted_at };
        if (textVersion !== TEXT[feature].version || !String(signedName || '').trim() || String(signedName).length > 160) deny('signature_required', 'Sign the current feature consent text.', 400);
        if (feature === 'cast' && adult !== true) deny('adult_required', 'Cast enrolment is for adults only.', 400);
        if (feature === 'library' && !regionAllowed(region)) deny('region_disabled', 'Library grouping is not enabled in this region.');
        await db.exec('INSERT INTO face_consents (id, subject, feature, scope, text_version, signature, granted_at, last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
            [s.newId('fco'), subject, feature, scope, textVersion, String(signedName).trim(), at]);
        return { feature, scope, text_version: textVersion, granted_at: at };
    }
    async function listConsents(subject) {
        const rows = await db.many('SELECT id, feature, scope, text_version, granted_at, revoked_at FROM face_consents WHERE subject=$1 ORDER BY granted_at DESC', [subject]);
        return rows;
    }
    async function revoke(subject, feature, channel) {
        if (!FEATURES.includes(feature)) deny('invalid_feature', 'Unknown face feature.', 400);
        const scope = scopeOf(feature, channel), at = timestamp();
        await s.tx(async (t) => {
            await t.exec('UPDATE face_consents SET revoked_at=$4, purpose_ends_at=$4 WHERE subject=$1 AND feature=$2 AND scope=$3 AND revoked_at IS NULL', [subject, feature, scope, at]);
            await t.exec('DELETE FROM face_templates WHERE subject=$1 AND feature=$2 AND scope=$3', [subject, feature, scope]);
            if (feature === 'cast') await t.exec('DELETE FROM face_tags WHERE subject=$1 AND channel=$2', [subject, scope]);
            if (feature === 'find' && !(await active(subject, 'library'))) await t.exec('DELETE FROM face_media WHERE subject=$1', [subject]);
            if (feature === 'library') {
                await t.exec('DELETE FROM face_clusters WHERE subject=$1', [subject]);
                if (!(await active(subject, 'find'))) await t.exec('DELETE FROM face_media WHERE subject=$1', [subject]);
            }
        });
        return { feature, scope, revoked_at: at, erased: true };
    }
    async function enrol(subject, feature, buffer, channel) {
        requireKey(); requireModel('yunet'); requireModel('sface');
        if (!['verify', 'find', 'cast'].includes(feature)) deny('invalid_feature', 'Enrolment needs verify, find or cast consent.', 400);
        const scope = scopeOf(feature, channel);
        await requireConsent(subject, feature, scope);
        const faces = await model.detect(buffer);
        if (faces.length !== 1) deny('one_face_required', 'Enrolment needs exactly one face.', 422);
        const vector = await model.embed(buffer, faces[0]), at = timestamp();
        await db.exec(`INSERT INTO face_templates (subject, feature, scope, ciphertext, created_at, last_used_at) VALUES ($1,$2,$3,$4,$5,$5)
            ON CONFLICT (subject, feature, scope) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, last_used_at=EXCLUDED.last_used_at`,
        [subject, feature, scope, seal(key, vector), at]);
        await touch(subject, feature, scope);
        return { enrolled: true, feature, scope, liveness: 'not_checked' };
    }
    async function template(subject, feature, scope = '') {
        requireKey(); await requireConsent(subject, feature, scope);
        const row = await db.maybe('SELECT ciphertext FROM face_templates WHERE subject=$1 AND feature=$2 AND scope=$3', [subject, feature, scope]);
        if (!row) deny('consent_required', `Enable ${feature} consent first.`);
        return open(key, row.ciphertext);
    }
    async function touch(subject, feature, scope = '') {
        const at = timestamp();
        await db.exec('UPDATE face_consents SET last_used_at=$4 WHERE subject=$1 AND feature=$2 AND scope=$3 AND revoked_at IS NULL', [subject, feature, scope, at]);
        await db.exec('UPDATE face_templates SET last_used_at=$4 WHERE subject=$1 AND feature=$2 AND scope=$3', [subject, feature, scope, at]);
    }
    async function verify(subject, buffer) {
        requireModel('yunet'); requireModel('sface');
        const own = await template(subject, 'verify');
        const faces = await model.detect(buffer);
        if (faces.length !== 1) deny('one_face_required', 'Verification needs exactly one face.', 422);
        const score = model.cosine(own, await model.embed(buffer, faces[0]));
        await touch(subject, 'verify');
        return { score, match: score >= config.faces.threshold, threshold: config.faces.threshold, liveness: 'not_checked' };
    }
    async function detect(buffer) { requireModel('yunet'); const faces = await model.detect(buffer); return { count: faces.length, boxes: faces.map(({ x, y, width, height, score }) => ({ x, y, width, height, score })) }; }
    async function blur(buffer) { requireModel('yunet'); const faces = await model.detect(buffer); return { count: faces.length, buffer: await model.blur(buffer, faces) }; }
    async function upload(subject, buffer, mime) {
        requireKey(); requireModel('yunet'); requireModel('sface');
        const findConsent = await active(subject, 'find'), libraryConsent = await active(subject, 'library');
        if (!findConsent && !libraryConsent) deny('consent_required', 'Enable find or library consent first.');
        const faces = await model.detect(buffer), vectors = [];
        for (const face of faces) vectors.push(await model.embed(buffer, face));
        const id = s.newId('fme'), at = timestamp();
        await db.exec('INSERT INTO face_media (id,subject,image_ciphertext,image_mime,vectors_ciphertext,created_at,last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$6)',
            [id, subject, seal(key, buffer), mime, seal(key, vectors), at]);
        if (findConsent) await touch(subject, 'find');
        if (libraryConsent) await touch(subject, 'library');
        return { id, private_link: `/api/v1/faces/media/${id}`, face_count: faces.length };
    }
    async function media(subject, id) {
        requireKey();
        // Check ownership before consent so another person cannot probe which media ids exist.
        const row = await db.maybe('SELECT image_ciphertext,image_mime FROM face_media WHERE id=$1 AND subject=$2', [id, subject]);
        if (!row) deny('not_found', 'No such media.', 404);
        if (!(await active(subject, 'find')) && !(await active(subject, 'library'))) deny('consent_required', 'Enable find or library consent first.');
        return { buffer: open(key, row.image_ciphertext, true), mime: row.image_mime };
    }
    async function find(subject) {
        const own = await template(subject, 'find');
        const rows = await db.many('SELECT id,vectors_ciphertext FROM face_media WHERE subject=$1 ORDER BY created_at DESC LIMIT 500', [subject]);
        const results = [];
        for (const row of rows) {
            const scores = open(key, row.vectors_ciphertext).map((v) => model.cosine(own, v));
            const score = Math.max(0, ...scores);
            if (score >= config.faces.threshold) results.push({ private_link: `/api/v1/faces/media/${row.id}`, score });
        }
        await touch(subject, 'find');
        return { results };
    }
    // Live calls this with a channel, a frame and a source-owned media reference. Only that channel's opted-in roster is read.
    async function castMatch(channel, buffer, mediaRef) {
        requireKey(); requireModel('yunet'); requireModel('sface'); scopeOf('cast', channel);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9:/_-]{1,159}$/.test(String(mediaRef || ''))) deny('invalid_media_ref', 'Provide a private media reference.', 400);
        const roster = await db.many(`SELECT c.subject,t.ciphertext FROM face_consents c JOIN face_templates t
            ON t.subject=c.subject AND t.feature='cast' AND t.scope=c.scope
            WHERE c.feature='cast' AND c.scope=$1 AND c.revoked_at IS NULL`, [channel]);
        const faces = await model.detect(buffer), matches = [];
        for (const face of faces) {
            const probe = await model.embed(buffer, face);
            const ranked = roster.map((r) => ({ subject: r.subject, score: model.cosine(open(key, r.ciphertext), probe) })).sort((a, b) => b.score - a.score);
            if (ranked[0] && ranked[0].score >= config.faces.threshold) {
                const row = ranked[0], at = timestamp();
                await db.exec('INSERT INTO face_tags (id,subject,channel,media_ref,created_at,last_used_at) VALUES ($1,$2,$3,$4,$5,$5)', [s.newId('ftg'), row.subject, channel, mediaRef, at]);
                await touch(row.subject, 'cast', channel);
                matches.push({ subject: row.subject, score: row.score, box: { x: face.x, y: face.y, width: face.width, height: face.height } });
            }
        }
        return { channel, matches, liveness: 'not_checked' };
    }
    async function tags(subject) { return db.many('SELECT id,channel,media_ref,created_at FROM face_tags WHERE subject=$1 ORDER BY created_at DESC', [subject]); }
    async function cluster(subject, region) {
        requireKey(); requireModel('yunet'); requireModel('sface');
        if (!regionAllowed(region)) deny('region_disabled', 'Library grouping is not enabled in this region.');
        await requireConsent(subject, 'library');
        const rows = await db.many('SELECT id,vectors_ciphertext FROM face_media WHERE subject=$1', [subject]);
        await db.exec('DELETE FROM face_clusters WHERE subject=$1', [subject]);
        const representatives = [];
        for (const row of rows) for (const vector of open(key, row.vectors_ciphertext)) {
            const at = timestamp();
            const match = representatives.find((g) => model.cosine(g.vector, vector) >= config.faces.threshold);
            const group = match ? match.id : s.newId('fgr');
            if (!match) representatives.push({ id: group, vector });
            await db.exec('INSERT INTO face_clusters (id,subject,media_id,vector_ciphertext,group_id,created_at,last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$6)',
                [s.newId('fcl'), subject, row.id, seal(key, vector), group, at]);
        }
        await touch(subject, 'library');
        return groups(subject);
    }
    async function groups(subject) {
        await requireConsent(subject, 'library');
        return db.many('SELECT id,media_id,group_id,label,excluded FROM face_clusters WHERE subject=$1 ORDER BY created_at DESC', [subject]);
    }
    async function correction(subject, action, ids) {
        await requireConsent(subject, 'library');
        if (!['exclude', 'merge', 'split'].includes(action) || !Array.isArray(ids) || !ids.length || ids.length > 100) deny('invalid_action', 'Use exclude, merge or split with cluster IDs.', 400);
        const rows = await db.many('SELECT id FROM face_clusters WHERE subject=$1 AND id=ANY($2::text[])', [subject, ids]);
        if (rows.length !== ids.length) deny('not_found', 'A cluster is not in your library.', 404);
        if (action === 'exclude') await db.exec('UPDATE face_clusters SET excluded=true,label=NULL WHERE subject=$1 AND id=ANY($2::text[])', [subject, ids]);
        if (action === 'merge') await db.exec('UPDATE face_clusters SET group_id=$3 WHERE subject=$1 AND id=ANY($2::text[]) AND excluded=false', [subject, ids, s.newId('fgr')]);
        if (action === 'split') for (const id of ids) await db.exec('UPDATE face_clusters SET group_id=$3 WHERE subject=$1 AND id=$2', [subject, id, s.newId('fgr')]);
        return { action, updated: rows.length };
    }
    async function retention() {
        const at = timestamp();
        const expired = await db.many(`SELECT subject,feature,scope FROM face_consents WHERE revoked_at IS NULL
            AND last_used_at <= $1::timestamptz - interval '3 years'`, [at]);
        for (const row of expired) await revoke(row.subject, row.feature, row.scope);
        // CUBI: dispose of audit consents within one year after the purpose ended.
        const old = await db.many(`SELECT id FROM face_consents WHERE revoked_at IS NOT NULL
            AND purpose_ends_at <= $1::timestamptz - interval '1 year'`, [at]);
        await db.exec(`DELETE FROM face_consents WHERE revoked_at IS NOT NULL
            AND purpose_ends_at <= $1::timestamptz - interval '1 year'`, [at]);
        return { expired: expired.length, consent_records_deleted: old.length };
    }
    return { TEXT, available: () => ({ ...model.available(), key: Boolean(key) }), consent, listConsents, revoke, enrol, verify, detect, blur, upload, media, find, castMatch, tags, cluster, groups, correction, retention, regionAllowed };
}
module.exports = { createFaces, FEATURES, TEXT, seal, open, keyOf };
