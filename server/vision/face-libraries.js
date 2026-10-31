'use strict';
const crypto = require('crypto');
const { VisionError } = require('./service');
const { seal, open, keyOf } = require('./faces');

const ID = {
    library: /^flb_[0-9A-HJKMNP-TV-Z]{26}$/,
    person: /^flp_[0-9A-HJKMNP-TV-Z]{26}$/,
    camera: /^cam_[0-9A-HJKMNP-TV-Z]{26}$/,
    subject: /^usr_[0-9A-HJKMNP-TV-Z]{26}$/,
};
const MAX_CAMERAS = 50;
const MAX_NAME = 80;
const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const fail = (code, detail, status = 403) => { throw new VisionError(status, `faces.${code}`, detail); };
const control = (v) => /[\u0000-\u001f\u007f]/.test(String(v == null ? '' : v));

function normaliseRegion(raw) {
    const r = text(raw).toUpperCase().replace(/\s+/g, '');
    return r && r.length <= 40 ? r : 'unknown';
}

function wireLibrary(row, { people = null, threshold } = {}) {
    if (!row) return null;
    return {
        id: row.id,
        camera_ids: Array.isArray(row.camera_ids) ? row.camera_ids : [],
        region: row.region,
        region_mode: row.region_mode,
        threshold: threshold == null ? Number(row.threshold) : Number(threshold),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        people_count: row.people_count == null ? undefined : Number(row.people_count),
        ...(people ? { people } : {}),
    };
}

function wirePerson(row) {
    if (!row) return null;
    return {
        id: row.id,
        library_id: row.library_id,
        name: row.name,
        subject: row.subject == null ? null : row.subject,
        status: row.status,
        consent_basis: row.consent_basis == null ? null : row.consent_basis,
        muted: Boolean(row.muted),
        has_template: Boolean(row.has_template),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        last_matched_at: row.last_matched_at == null ? null : (row.last_matched_at instanceof Date ? row.last_matched_at.toISOString() : String(row.last_matched_at)),
    };
}

/**
 * A camera owner's own familiar-face library (F1).
 *
 * There is exactly one template per named person, and a match reads only the library it was asked about. The
 * consent rules are here, not in the page: the camera's region mode decides whether the named person's consent is
 * checked in Network's registry (strict) or the owner names the face freely (open). Until consent the person has
 * status pending_consent, an encrypted crop for the later enrolment, and no template at all.
 */
function createFaceLibraries({ s, config, model, faces, network, log = console }) {
    const db = s.db;
    const key = keyOf(config.faces.key);
    const timestamp = () => s.iso();
    const requireKey = () => { if (!key) fail('key_unavailable', 'Face encryption is not configured.', 503); };
    const requireModel = () => {
        const a = model.available();
        if (!a.yunet || !a.sface) fail('model_unavailable', 'Face weights are not installed.', 503);
    };
    const strict = (region) => {
        const r = normaliseRegion(region);
        if (r === 'UNKNOWN') return true;
        return (config.faces.strictRegions || []).some((x) => x === r || (x.endsWith('*') && r.startsWith(x.slice(0, -1))));
    };
    const regionMode = (region) => (strict(region) ? 'strict' : 'open');

    function camerasOf(body) {
        const raw = body && body.camera_ids !== undefined ? body.camera_ids : body && body.camera_id !== undefined ? [body.camera_id] : [];
        if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CAMERAS) fail('invalid_cameras', `Name 1 to ${MAX_CAMERAS} cameras.`, 400);
        const out = [...new Set(raw.map((x) => text(x)))];
        if (out.some((x) => !ID.camera.test(x))) fail('invalid_cameras', 'A camera id is a Cam camera id (cam_…).', 400);
        return out;
    }

    function cleanName(raw) {
        const name = text(raw);
        if (!name || name.length > MAX_NAME || control(raw)) fail('invalid_name', `A name is 1 to ${MAX_NAME} characters of plain text.`, 400);
        return name;
    }

    async function validateSubject(raw) {
        if (raw == null || raw === '') return null;
        const subject = text(raw);
        if (!ID.subject.test(subject)) fail('invalid_subject', 'subject must be a person\'s canonical usr_ id.', 400);
        return subject;
    }

    async function libraryOf(owner, id) {
        const row = await db.maybe('SELECT * FROM face_libraries WHERE id=$1 AND owner=$2', [String(id || ''), owner]);
        if (!row) fail('not_found', 'No such face library.', 404);
        return row;
    }

    async function personOf(owner, library, id) {
        const row = await db.maybe(`SELECT p.*, (t.ciphertext IS NOT NULL) AS has_template
            FROM face_library_people p LEFT JOIN face_templates t
              ON t.library_id=p.library_id AND t.scope=p.id AND t.feature='library'
            WHERE p.id=$1 AND p.library_id=$2 AND p.owner=$3`, [String(id || ''), library.id, owner]);
        if (!row) fail('not_found', 'No such named face in this library.', 404);
        return row;
    }

    async function peopleOf(library) {
        const rows = await db.many(`SELECT p.*, (t.ciphertext IS NOT NULL) AS has_template
            FROM face_library_people p LEFT JOIN face_templates t
              ON t.library_id=p.library_id AND t.scope=p.id AND t.feature='library'
            WHERE p.library_id=$1 ORDER BY p.created_at DESC, p.id DESC`, [library.id]);
        return rows.map(wirePerson);
    }

    async function create(owner, body = {}) {
        requireKey();
        const cameraIds = camerasOf(body);
        const region = normaliseRegion(body.region);
        const mode = regionMode(region);
        const existing = await db.many('SELECT id, camera_ids FROM face_libraries WHERE owner=$1', [owner]);
        for (const row of existing) {
            const ids = Array.isArray(row.camera_ids) ? row.camera_ids : [];
            if (ids.some((id) => cameraIds.includes(id))) fail('camera_already_library', 'That camera already has a familiar-faces library.', 409);
        }
        const threshold = body.threshold == null ? config.faces.threshold : Number(body.threshold);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) fail('invalid_threshold', 'threshold is from 0 to 1.', 400);
        const id = s.newId('flb'), at = timestamp();
        const row = await db.maybe(`INSERT INTO face_libraries (id, owner, camera_ids, region, region_mode, threshold, created_at, updated_at)
            VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7::timestamptz,$7::timestamptz) RETURNING *`,
        [id, owner, JSON.stringify(cameraIds), region, mode, threshold, at]);
        return wireLibrary(row, { people: [] });
    }

    async function list(owner) {
        const rows = await db.many(`SELECT l.*, (SELECT COUNT(*)::int FROM face_library_people p WHERE p.library_id=l.id) AS people_count
            FROM face_libraries l WHERE l.owner=$1 ORDER BY l.created_at DESC, l.id DESC`, [owner]);
        return rows.map((r) => wireLibrary(r));
    }

    async function get(owner, id) {
        const row = await libraryOf(owner, id);
        return wireLibrary(row, { people: await peopleOf(row) });
    }

    async function patch(owner, id, body = {}) {
        requireKey();
        const row = await libraryOf(owner, id);
        const sets = [];
        const args = [row.id];
        if (body.camera_ids !== undefined || body.camera_id !== undefined) {
            const cameraIds = camerasOf(body);
            const others = await db.many('SELECT id, camera_ids FROM face_libraries WHERE owner=$1 AND id<>$2', [owner, row.id]);
            for (const other of others) {
                const ids = Array.isArray(other.camera_ids) ? other.camera_ids : [];
                if (ids.some((x) => cameraIds.includes(x))) fail('camera_already_library', 'That camera already has a familiar-faces library.', 409);
            }
            args.push(JSON.stringify(cameraIds)); sets.push(`camera_ids=$${args.length}::jsonb`);
        }
        if (body.region !== undefined) {
            const region = normaliseRegion(body.region);
            args.push(region); sets.push(`region=$${args.length}`);
            args.push(regionMode(region)); sets.push(`region_mode=$${args.length}`);
        }
        if (body.threshold !== undefined) {
            const n = Number(body.threshold);
            if (!Number.isFinite(n) || n < 0 || n > 1) fail('invalid_threshold', 'threshold is from 0 to 1.', 400);
            args.push(n); sets.push(`threshold=$${args.length}`);
        }
        if (!sets.length) fail('invalid', 'Send camera_ids, region or threshold.', 400);
        args.push(timestamp());
        const updated = await db.maybe(`UPDATE face_libraries SET ${sets.join(', ')}, updated_at=$${args.length}::timestamptz
            WHERE id=$1 RETURNING *`, args);
        return wireLibrary(updated, { people: await peopleOf(updated) });
    }

    async function remove(owner, id) {
        requireKey();
        const row = await libraryOf(owner, id);
        const counts = await db.maybe(`SELECT
            (SELECT COUNT(*)::int FROM face_library_people WHERE library_id=$1) AS people,
            (SELECT COUNT(*)::int FROM face_library_crops WHERE library_id=$1) AS crops,
            (SELECT COUNT(*)::int FROM face_templates WHERE library_id=$1) AS templates,
            (SELECT COUNT(*)::int FROM face_consent_requests WHERE library_id=$1) AS requests`, [row.id]);
        await db.exec('DELETE FROM face_libraries WHERE id=$1 AND owner=$2', [row.id, owner]);
        return { deleted: true, id: row.id, people: Number(counts.people), crops: Number(counts.crops), templates: Number(counts.templates), requests: Number(counts.requests) };
    }

    async function saveCrop(library, person, buffer, mime, kind) {
        await db.exec('DELETE FROM face_library_crops WHERE person_id=$1 AND library_id=$2', [person.id, library.id]);
        await db.exec(`INSERT INTO face_library_crops (id, library_id, person_id, owner, kind, image_ciphertext, image_mime, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [s.newId('flc'), library.id, person.id, library.owner, kind, seal(key, buffer), mime, timestamp()]);
    }

    async function latestCrop(person) {
        const row = await db.maybe('SELECT image_ciphertext FROM face_library_crops WHERE person_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [person.id]);
        if (!row) return null;
        return open(key, row.image_ciphertext, true);
    }

    async function putTemplate(library, person, vector) {
        const at = timestamp();
        await db.exec(`INSERT INTO face_templates (subject, feature, scope, ciphertext, created_at, last_used_at, library_id)
            VALUES ($1,'library',$2,$3,$4::timestamptz,$4::timestamptz,$5)
            ON CONFLICT (subject, feature, scope) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, last_used_at=EXCLUDED.last_used_at, library_id=EXCLUDED.library_id`,
        [library.owner, person.id, seal(key, vector), at, library.id]);
    }

    async function embedCrop(buffer) {
        const found = await model.detect(buffer);
        if (found.length !== 1) fail('one_face_required', 'Naming a face needs exactly one face in the crop.', 422);
        return await model.embed(buffer, found[0]);
    }

    async function requestLink(library, person) {
        const token = crypto.randomBytes(24).toString('base64url');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        const at = timestamp();
        const expires = new Date(s.now() + Number(config.faces.consentRequestDays) * 86_400_000).toISOString();
        await s.tx(async (t) => {
            await t.exec("UPDATE face_consent_requests SET status='expired', decided_at=$2::timestamptz WHERE person_id=$1 AND status='pending'", [person.id, at]);
            await t.exec(`INSERT INTO face_consent_requests (id, library_id, person_id, owner, subject, token_hash, status, text_version, requested_at, expires_at)
                VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8::timestamptz,$9::timestamptz)`,
            [s.newId('fcr'), library.id, person.id, library.owner, person.subject == null ? null : person.subject, hash, faces.TEXT.library.version, at, expires]);
        });
        const url = `${String(config.baseUrl).replace(/\/+$/, '')}/people/privacy?face_request=${encodeURIComponent(token)}`;
        let sent = false;
        if (person.subject) {
            const got = await network.notify(person.subject, {
                title: 'A camera owner asked to know your face',
                message: 'Open OpenVibe.Vision to choose whether your face may be recognised in their camera. Until you do, the camera only sees a familiar visitor, and no template is stored.',
                url,
            });
            sent = Boolean(got && got.sent);
        }
        return { token, url, expires_at: expires, sent, text_version: faces.TEXT.library.version };
    }

    /**
     * Name a face from the crop the camera saw. In strict mode this returns pending_consent (no template) until the
     * person's consent is in the registry or they accept the link. Open mode enrols at once.
     */
    async function enroll(owner, id, buffer, body = {}) {
        requireKey(); requireModel();
        const library = await libraryOf(owner, id);
        const name = cleanName(body.name);
        const subject = await validateSubject(body.subject);
        const at = timestamp();
        const vector = await embedCrop(buffer);
        const mime = body.image_mime ? String(body.image_mime) : 'image/jpeg';
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) fail('invalid_image', 'The crop must be JPEG, PNG or WebP.', 400);

        let person = await db.maybe('SELECT * FROM face_library_people WHERE library_id=$1 AND lower(name)=lower($2) AND status<>\'denied\'', [library.id, name]);
        const consented = library.region_mode === 'open' || (subject ? await network.allowed(subject) : false);
        const status = consented ? 'active' : 'pending_consent';
        const basis = consented ? (library.region_mode === 'open' ? null : 'network') : null;

        if (!person) {
            person = await db.maybe(`INSERT INTO face_library_people (id, library_id, owner, name, subject, status, consent_basis, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$8::timestamptz) RETURNING *`,
            [s.newId('flp'), library.id, owner, name, subject, status, basis, at]);
        } else {
            person = await db.maybe(`UPDATE face_library_people SET name=$2, subject=COALESCE($3,subject), status=$4, consent_basis=$5, updated_at=$6::timestamptz
                WHERE id=$1 RETURNING *`, [person.id, name, subject, status, basis, at]);
        }
        await saveCrop(library, person, buffer, mime, status === 'active' ? 'enrol' : 'pending');

        if (status === 'active') {
            await putTemplate(library, person, vector);
            await db.exec("UPDATE face_consent_requests SET status='expired', decided_at=$2::timestamptz WHERE person_id=$1 AND status='pending'", [person.id, at]);
            return { person: wirePerson({ ...person, has_template: true }), consent_request: null, enrolled: true };
        }
        // Pending consent means no template at all, including an earlier one for this name.
        await db.exec("DELETE FROM face_templates WHERE library_id=$1 AND scope=$2 AND feature='library'", [library.id, person.id]);
        const request = await requestLink(library, person);
        return { person: wirePerson({ ...person, has_template: false }), consent_request: request, enrolled: false };
    }

    /** Is this named person's consent still there? Strict mode re-checks the registry on the next match; the
     *  private-link acceptance is a local face_consents row, and a revoked one no longer counts. */
    async function consentActive(library, person) {
        if (library.region_mode !== 'strict') return true;
        if (!person.subject) return false;
        if (person.consent_basis === 'request') {
            const row = await db.maybe("SELECT 1 AS ok FROM face_consents WHERE subject=$1 AND feature='library' AND revoked_at IS NULL LIMIT 1", [person.subject]);
            return Boolean(row);
        }
        return await network.allowed(person.subject);
    }

    async function deactivatePending(library, personId) {
        await s.tx(async (t) => {
            await t.exec("DELETE FROM face_templates WHERE library_id=$1 AND scope=$2 AND feature='library'", [library.id, personId]);
            await t.exec("UPDATE face_library_people SET status='pending_consent', consent_basis=NULL, updated_at=$2::timestamptz WHERE id=$1 AND status='active'", [personId, timestamp()]);
        });
    }

    async function match(owner, id, buffer) {
        requireKey(); requireModel();
        const library = await libraryOf(owner, id);
        const found = await model.detect(buffer);
        if (found.length !== 1) fail('one_face_required', 'A match needs exactly one face in the crop.', 422);
        const probe = await model.embed(buffer, found[0]);
        // Only this library's templates: the owner and library_id are both in the query, so another person's
        // library is never read (and an empty library answers unknown without a lookup anywhere else).
        const rows = await db.many(`SELECT p.id, p.name, p.muted, p.subject, p.consent_basis, t.ciphertext
            FROM face_templates t JOIN face_library_people p
              ON p.library_id=t.library_id AND p.id=t.scope AND p.status='active'
            WHERE t.subject=$1 AND t.library_id=$2 AND t.feature='library'`, [owner, library.id]);
        const ranked = rows.map((row) => ({ ...row, score: model.cosine(open(key, row.ciphertext), probe) })).sort((a, b) => b.score - a.score);
        const threshold = Number(library.threshold);
        let best = null;
        for (const row of ranked.slice(0, 10)) {
            if (!(await consentActive(library, row))) {
                // The person's consent is gone: the template goes at once and the next check answers unknown.
                await deactivatePending(library, row.id);
                continue;
            }
            if (row.score >= threshold) { best = row; break; }
            if (!best) best = { ...row, score: row.score };
        }
        if (!best || best.score < threshold) {
            return { library_id: library.id, match: false, label: 'unknown person', name: null, person_id: null, muted: false, score: best ? best.score : null, threshold };
        }
        await db.exec('UPDATE face_library_people SET last_matched_at=$2::timestamptz WHERE id=$1', [best.id, timestamp()]);
        return { library_id: library.id, match: true, label: best.name, name: best.name, person_id: best.id, muted: best.muted, score: best.score, threshold };
    }

    async function people(owner, id) {
        const library = await libraryOf(owner, id);
        return { library: wireLibrary(library), people: await peopleOf(library) };
    }

    async function patchPerson(owner, id, personId, body = {}) {
        const library = await libraryOf(owner, id);
        const person = await personOf(owner, library, personId);
        const sets = [];
        const args = [person.id];
        if (body.name !== undefined) {
            const name = cleanName(body.name);
            const clash = await db.maybe(`SELECT id FROM face_library_people WHERE library_id=$1 AND lower(name)=lower($2) AND status<>'denied' AND id<>$3`,
                [library.id, name, person.id]);
            if (clash) fail('name_taken', 'That name is already in this library.', 409);
            args.push(name); sets.push(`name=$${args.length}`);
        }
        if (body.muted !== undefined) {
            args.push(Boolean(body.muted)); sets.push(`muted=$${args.length}`);
        }
        if (!sets.length) fail('invalid', 'Send a name or muted.', 400);
        args.push(timestamp());
        const updated = await db.maybe(`UPDATE face_library_people SET ${sets.join(', ')}, updated_at=$${args.length}::timestamptz WHERE id=$1 RETURNING *`, args);
        const has = await db.maybe("SELECT 1 AS ok FROM face_templates WHERE library_id=$1 AND scope=$2 AND feature='library'", [library.id, person.id]);
        return wirePerson({ ...updated, has_template: Boolean(has) });
    }

    async function removePerson(owner, id, personId) {
        requireKey();
        const library = await libraryOf(owner, id);
        const person = await personOf(owner, library, personId);
        const templates = await db.maybe("SELECT COUNT(*)::int AS n FROM face_templates WHERE library_id=$1 AND scope=$2 AND feature='library'", [library.id, person.id]);
        const crops = await db.maybe('SELECT COUNT(*)::int AS n FROM face_library_crops WHERE person_id=$1', [person.id]);
        const requests = await db.maybe('SELECT COUNT(*)::int AS n FROM face_consent_requests WHERE person_id=$1', [person.id]);
        await s.tx(async (t) => {
            await t.exec("DELETE FROM face_templates WHERE library_id=$1 AND scope=$2 AND feature='library'", [library.id, person.id]);
            await t.exec('DELETE FROM face_consent_requests WHERE person_id=$1', [person.id]);
            await t.exec('DELETE FROM face_library_crops WHERE person_id=$1', [person.id]);
            await t.exec('DELETE FROM face_library_people WHERE id=$1', [person.id]);
        });
        return { deleted: true, id: person.id, name: person.name, templates: Number(templates.n), crops: Number(crops.n), requests: Number(requests.n) };
    }

    /** Re-check the registry for pending people. The camera page may call this when it opens; a match never waits on it. */
    async function checkPending(owner, id) {
        const library = await libraryOf(owner, id);
        const pending = await db.many("SELECT * FROM face_library_people WHERE library_id=$1 AND owner=$2 AND status='pending_consent' AND subject IS NOT NULL ORDER BY created_at LIMIT 50", [library.id, owner]);
        const activated = [];
        for (const person of pending) {
            if (!(await network.allowed(person.subject))) continue;
            const crop = await latestCrop(person);
            if (!crop) continue;
            let vector;
            try { vector = await embedCrop(crop); } catch { continue; }
            await s.tx(async (t) => {
                await t.exec("UPDATE face_library_people SET status='active', consent_basis='network', updated_at=$2::timestamptz WHERE id=$1 AND status='pending_consent'", [person.id, timestamp()]);
                await t.exec("UPDATE face_consent_requests SET status='accepted', decided_at=$2::timestamptz WHERE person_id=$1 AND status='pending'", [person.id, timestamp()]);
            });
            await putTemplate(library, person, vector);
            activated.push(wirePerson({ ...person, status: 'active', consent_basis: 'network', has_template: true }));
        }
        return { checked: pending.length, activated };
    }

    async function requestAgain(owner, id, personId) {
        const library = await libraryOf(owner, id);
        const person = await personOf(owner, library, personId);
        if (person.status !== 'pending_consent') fail('already_decided', 'That name is not waiting for consent.', 409);
        return await requestLink(library, person);
    }

    async function acceptRequest(actor, token, body = {}) {
        requireKey(); requireModel();
        const raw = text(token);
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(raw)) fail('request_not_found', 'No such consent request.', 404);
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const row = await db.maybe(`SELECT r.*, l.owner, l.region, p.name AS person_name, p.subject AS person_subject
            FROM face_consent_requests r JOIN face_libraries l ON l.id=r.library_id
            JOIN face_library_people p ON p.id=r.person_id
            WHERE r.token_hash=$1`, [hash]);
        if (!row || row.status !== 'pending') fail('request_not_found', 'No such open consent request.', 404);
        if (Date.parse(row.expires_at) <= s.now()) {
            await db.exec("UPDATE face_consent_requests SET status='expired', decided_at=$2::timestamptz WHERE id=$1", [row.id, timestamp()]);
            fail('request_expired', 'That consent request has expired; ask the camera owner for a new link.', 410);
        }
        if (row.subject && row.subject !== actor) fail('request_not_yours', 'This consent request names another person.', 403);
        const signedName = text(body.signed_name);
        if (!signedName || signedName.length > 160 || control(body.signed_name)) fail('signature_required', 'Sign the current face-library consent text.', 400);
        if (body.text_version !== faces.TEXT.library.version || body.text_version !== row.text_version) fail('signature_required', 'Read the current consent text and sign it.', 400);
        const crop = await latestCrop({ id: row.person_id });
        if (!crop) fail('crop_missing', 'The camera crop is no longer available; ask the owner to name you again.', 409);
        const vector = await embedCrop(crop);
        const at = timestamp();
        await s.tx(async (t) => {
            await t.exec(`UPDATE face_consent_requests SET status='accepted', subject=COALESCE(subject,$2), decided_at=$3::timestamptz WHERE id=$1`, [row.id, actor, at]);
            await t.exec(`UPDATE face_library_people SET subject=COALESCE(subject,$2), status='active', consent_basis='request', updated_at=$3::timestamptz WHERE id=$1`, [row.person_id, actor, at]);
            const active = await t.maybe("SELECT id FROM face_consents WHERE subject=$1 AND feature='library' AND revoked_at IS NULL LIMIT 1", [actor]);
            if (!active) {
                await t.exec(`INSERT INTO face_consents (id, subject, feature, scope, text_version, signature, granted_at, last_used_at)
                    VALUES ($1,$2,'library','',$3,$4,$5::timestamptz,$5::timestamptz)`,
                [s.newId('fco'), actor, faces.TEXT.library.version, signedName, at]);
            }
        });
        const library = await db.maybe('SELECT * FROM face_libraries WHERE id=$1', [row.library_id]);
        const person = await db.maybe('SELECT * FROM face_library_people WHERE id=$1', [row.person_id]);
        await putTemplate(library, person, vector);
        return { accepted: true, library_id: row.library_id, person: wirePerson({ ...person, has_template: true }), text_version: faces.TEXT.library.version };
    }

    async function denyRequest(actor, token) {
        const raw = text(token);
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(raw)) fail('request_not_found', 'No such consent request.', 404);
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const row = await db.maybe('SELECT * FROM face_consent_requests WHERE token_hash=$1', [hash]);
        if (!row || row.status !== 'pending') fail('request_not_found', 'No such open consent request.', 404);
        if (row.subject && row.subject !== actor) fail('request_not_yours', 'This consent request names another person.', 403);
        const at = timestamp();
        await s.tx(async (t) => {
            await t.exec("UPDATE face_consent_requests SET status='denied', subject=COALESCE(subject,$2), decided_at=$3::timestamptz WHERE id=$1", [row.id, actor, at]);
            await t.exec("UPDATE face_library_people SET status='denied', updated_at=$2::timestamptz WHERE id=$1", [row.person_id, at]);
            await t.exec('DELETE FROM face_library_crops WHERE person_id=$1', [row.person_id]);
        });
        return { denied: true, library_id: row.library_id };
    }

    return { text: faces.TEXT.library, regionMode, strict, create, list, get, patch, remove, enroll, match, people, patchPerson, removePerson, checkPending, requestAgain, acceptRequest, denyRequest, _libraryOf: libraryOf };
}

module.exports = { createFaceLibraries, ID, normaliseRegion, wireLibrary, wirePerson };
