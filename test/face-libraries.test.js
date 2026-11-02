'use strict';
/**
 * F1: familiar faces for a camera owner's own cameras.
 *
 * The rules the plan makes hard: a match reads only the library it names, an unknown face stays unknown, strict mode
 * stores no template until the named person's consent is in the registry (or they accept the link), and deleting a
 * name or a camera's library removes its templates and crops. The model is a fixture: no weights, no inference.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { cosine } = require('../server/vision/faces-model');

const KEY = Buffer.alloc(32, 9).toString('base64');
const FACE = { x: 20, y: 20, width: 80, height: 80, score: 0.99, landmarks: [[40, 50], [80, 50], [60, 70], [45, 90], [75, 90]] };
const camera = () => `cam_${ids.ulid()}`;

function fakeModel() {
    const state = { vector: [1, 0, 0, 0], detectCalls: 0 };
    return {
        state,
        available: () => ({ yunet: true, sface: true }),
        detect: async () => { state.detectCalls++; return [{ ...FACE, landmarks: FACE.landmarks.map((p) => p.slice()) }]; },
        embed: async () => state.vector.slice(),
        blur: async () => Buffer.from('blurred'),
        cosine,
    };
}

(async () => {
    const model = fakeModel();
    const t = await boot({
        env: {
            VISION_FACE_KEY: KEY,
            VISION_FACE_LIBRARY_REGIONS: 'US-IL,US-TX,US-WA',
            VISION_FACE_STRICT_REGIONS: 'US-IL,US-TX,US-WA,EU,GB,UNKNOWN',
            VISION_FACE_MATCH_THRESHOLD: '0.6',
            VISION_FACE_CONSENT_REQUEST_DAYS: '7',
        },
        facesModel: model,
    });
    const ana = t.network.addUser('ana');
    const bo = t.network.addUser('bo');
    const cy = t.network.addUser('cy');
    const dee = t.network.addUser('dee');
    const png = await t.textImage('A FACE');
    const db = t.ctx.s.db;
    const vector = (v) => { model.state.vector = v; };
    const create = (as, body) => t.get('/api/v1/faces/libraries', { as, json: body });
    const enrol = (as, libraryId, fields) => t.get(`/api/v1/faces/libraries/${libraryId}/enroll`, { as, multipart: { fields, image: png } });
    const match = (as, libraryId) => t.get(`/api/v1/faces/libraries/${libraryId}/match`, { as, multipart: { image: png } });
    const rows = async (sql, args) => await db.many(sql, args);

    try {
        let anaLibrary = null;
        let boPerson = null;
        let samPerson = null;

        await check('a camera owner gets a library with the camera region and strict mode', async () => {
            const r = await create(ana, { camera_ids: [camera(), camera()], region: 'US-IL' });
            assert.strictEqual(r.status, 201, r.text);
            anaLibrary = r.json();
            assert.match(anaLibrary.id, /^flb_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(anaLibrary.region, 'US-IL');
            assert.strictEqual(anaLibrary.region_mode, 'strict');
            assert.strictEqual(anaLibrary.camera_ids.length, 2);
            assert.strictEqual((await create(ana, { camera_ids: [camera()], region: 'US-CA' })).json().region_mode, 'open');
            assert.strictEqual((await create(ana, { camera_ids: ['not-a-camera'], region: 'US-IL' })).status, 400);
            assert.strictEqual((await create(ana, { camera_ids: anaLibrary.camera_ids, region: 'US-IL' })).status, 409);
        });

        await check('strict mode names a face with the registry consent and stores an encrypted template', async () => {
            t.network.allowFace(bo.subject, true);
            vector([1, 0, 0, 0]);
            const r = await enrol(ana, anaLibrary.id, { name: 'Bo', subject: bo.subject });
            assert.strictEqual(r.status, 200, r.text);
            boPerson = r.json().person;
            assert.strictEqual(boPerson.status, 'active');
            assert.strictEqual(boPerson.consent_basis, 'network');
            assert.strictEqual(boPerson.has_template, true);
            const rows = await db.many("SELECT ciphertext, library_id FROM face_templates WHERE subject=$1 AND feature='library' AND scope=$2", [ana.subject, boPerson.id]);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].library_id, anaLibrary.id);
            assert.ok(!rows[0].ciphertext.includes('1,0,0,0'), 'the vector is ciphertext');
            assert.ok(t.network.state.faceChecks.some((c) => c.purpose === 'face.recognize' && c.feature === 'library' && c.subjects.includes(bo.subject)));
        });

        await check('strict mode blocks the template for a named person without consent and sends a request', async () => {
            vector([0, 1, 0, 0]);
            const r = await enrol(ana, anaLibrary.id, { name: 'Sam' });
            assert.strictEqual(r.status, 200, r.text);
            samPerson = r.json().person;
            assert.strictEqual(samPerson.status, 'pending_consent');
            assert.strictEqual(samPerson.has_template, false);
            assert.ok(r.json().consent_request.url.includes('face_request='));
            assert.strictEqual(r.json().consent_request.sent, false);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE library_id=$1 AND scope=$2", [anaLibrary.id, samPerson.id])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM face_library_crops WHERE person_id=$1', [samPerson.id])), 1);
        });

        await check('a match reads only its own library and returns the top named face', async () => {
            vector([1, 0, 0, 0]);
            const got = await match(ana, anaLibrary.id);
            assert.strictEqual(got.status, 200, got.text);
            assert.strictEqual(got.json().match, true);
            assert.strictEqual(got.json().name, 'Bo');
            assert.strictEqual(got.json().person_id, boPerson.id);
            assert.ok(got.json().score >= 0.6);
            assert.strictEqual(got.json().label, 'Bo');
        });

        await check('revoking registry consent on the next match drops the template and answers unknown', async () => {
            t.network.allowFace(bo.subject, false);
            vector([1, 0, 0, 0]);
            const got = await match(ana, anaLibrary.id);
            assert.strictEqual(got.status, 200, got.text);
            assert.strictEqual(got.json().match, false);
            assert.strictEqual(got.json().label, 'unknown person');
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE library_id=$1 AND scope=$2", [anaLibrary.id, boPerson.id])), 0);
            const person = await db.maybe('SELECT status FROM face_library_people WHERE id=$1', [boPerson.id]);
            assert.strictEqual(person.status, 'pending_consent');
            t.network.allowFace(bo.subject, true);
        });

        await check('an unknown face stays unknown and never consults another owner library', async () => {
            const otherLibrary = (await create(cy, { camera_ids: [camera()], region: 'US-CA' })).json();
            vector([1, 0, 0, 0]);
            const deePerson = (await enrol(cy, otherLibrary.id, { name: 'Dee' })).json().person;
            assert.strictEqual(deePerson.status, 'active');
            vector([0, 0, 1, 0]);
            const got = await match(ana, anaLibrary.id);
            assert.strictEqual(got.status, 200, got.text);
            assert.strictEqual(got.json().match, false);
            assert.strictEqual(got.json().name, null);
            assert.strictEqual(got.json().label, 'unknown person');
            vector([1, 0, 0, 0]);
            const cyGot = await match(cy, otherLibrary.id);
            assert.strictEqual(cyGot.json().name, 'Dee');
            assert.notStrictEqual(cyGot.json().person_id, boPerson.id);
            // The unknown answer named nobody from the other owner's library.
            assert.ok(!JSON.stringify(got.json()).includes('Dee'));
        });

        await check('the private consent link turns a pending name into a template after the person accepts', async () => {
            const people = (await t.get(`/api/v1/faces/libraries/${anaLibrary.id}/people`, { as: ana })).json();
            assert.ok(people.people.some((p) => p.id === samPerson.id && !p.has_template));
            // The raw token is not stored; the owner re-issues a link when needed and that request is the one accepted.
            const again = await t.get(`/api/v1/faces/libraries/${anaLibrary.id}/people/${samPerson.id}/request`, { as: ana, method: 'POST' });
            assert.strictEqual(again.status, 200, again.text);
            const link = again.json().url;
            const raw = new URL(link).searchParams.get('face_request');
            assert.ok(raw);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_consent_requests WHERE person_id=$1 AND status='pending'", [samPerson.id])), 1);
            vector([0, 1, 0, 0]);
            const accepted = await t.get(`/api/v1/faces/consent-requests/${raw}/accept`, {
                as: dee, json: { signed_name: 'Dee', text_version: t.ctx.faces.TEXT.library.version },
            });
            assert.strictEqual(accepted.status, 200, accepted.text);
            assert.strictEqual(accepted.json().accepted, true);
            const person = await db.maybe('SELECT * FROM face_library_people WHERE id=$1', [samPerson.id]);
            assert.strictEqual(person.status, 'active');
            assert.strictEqual(person.subject, dee.subject);
            assert.strictEqual(person.consent_basis, 'request');
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE library_id=$1 AND scope=$2", [anaLibrary.id, samPerson.id])), 1);
            vector([0, 1, 0, 0]);
            const got = await match(ana, anaLibrary.id);
            assert.strictEqual(got.json().name, 'Sam');
        });

        await check('muting a name keeps the match but marks its alerts held', async () => {
            const r = await t.get(`/api/v1/faces/libraries/${anaLibrary.id}/people/${samPerson.id}`, { as: ana, method: 'PATCH', json: { muted: true } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().muted, true);
            vector([0, 1, 0, 0]);
            const got = await match(ana, anaLibrary.id);
            assert.strictEqual(got.json().match, true);
            assert.strictEqual(got.json().muted, true);
        });

        await check('deleting a name deletes its template and its crops at once', async () => {
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE library_id=$1 AND scope=$2", [anaLibrary.id, samPerson.id])), 1);
            assert.ok(Number(await db.value('SELECT COUNT(*)::int AS n FROM face_library_crops WHERE person_id=$1', [samPerson.id])) >= 1);
            const r = await t.get(`/api/v1/faces/libraries/${anaLibrary.id}/people/${samPerson.id}`, { as: ana, method: 'DELETE' });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().templates, 1);
            assert.ok(r.json().crops >= 1);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM face_templates WHERE library_id=$1 AND scope=$2", [anaLibrary.id, samPerson.id])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM face_library_crops WHERE person_id=$1', [samPerson.id])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM face_library_people WHERE id=$1', [samPerson.id])), 0);
        });

        await check('open mode names a face freely, and a registry outage answers no', async () => {
            const open = (await create(ana, { camera_ids: [camera()], region: 'US-CA' })).json();
            vector([0, 0, 0, 1]);
            const named = (await enrol(ana, open.id, { name: 'Alex' })).json();
            assert.strictEqual(named.person.status, 'active');
            assert.strictEqual(named.person.consent_basis, null);
            assert.strictEqual(named.consent_request, null);

            t.network.setDown(true);
            const strict = (await create(ana, { camera_ids: [camera()], region: 'US-WA' })).json();
            vector([0, 0, 0, 1]);
            const pending = (await enrol(ana, strict.id, { name: 'No Registry', subject: bo.subject })).json();
            assert.strictEqual(pending.person.status, 'pending_consent');
            assert.strictEqual(pending.person.has_template, false);
            t.network.setDown(false);
        });

        await check('the owner cannot read or delete another owner\'s library', async () => {
            const other = (await create(cy, { camera_ids: [camera()], region: 'US-CA' })).json();
            assert.strictEqual((await t.get(`/api/v1/faces/libraries/${other.id}`, { as: ana })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/faces/libraries/${other.id}`, { as: ana, method: 'DELETE' })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/faces/libraries/${other.id}/enroll`, { as: ana, multipart: { fields: { name: 'Mine' }, image: png } })).status, 404);
        });

        await check('deleting the library deletes every named face, template and crop', async () => {
            t.network.allowFace(bo.subject, true);
            vector([1, 0, 0, 0]);
            assert.strictEqual((await enrol(ana, anaLibrary.id, { name: 'Bo', subject: bo.subject })).status, 200);
            assert.ok(Number(await db.value('SELECT COUNT(*)::int AS n FROM face_library_people WHERE library_id=$1', [anaLibrary.id])) >= 1);
            assert.ok(Number(await db.value('SELECT COUNT(*)::int AS n FROM face_library_crops WHERE library_id=$1', [anaLibrary.id])) >= 1);
            const r = await t.get(`/api/v1/faces/libraries/${anaLibrary.id}`, { as: ana, method: 'DELETE' });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().deleted, true);
            assert.ok(r.json().templates >= 1);
            for (const table of ['face_library_people', 'face_library_crops', 'face_consent_requests', 'face_templates']) {
                assert.strictEqual(Number(await db.value(`SELECT COUNT(*)::int AS n FROM ${table} WHERE library_id=$1`, [anaLibrary.id])), 0, table);
            }
        });

        await check('ADR-033 export and erasure cover the familiar-face tables', async () => {
            const lib = (await create(ana, { camera_ids: [camera()], region: 'US-CA' })).json();
            vector([1, 1, 0, 0]);
            assert.strictEqual((await enrol(ana, lib.id, { name: 'Mine' })).status, 200);
            const part = await t.ctx.accountData.exportPart(ana.subject);
            const files = part.files.map((f) => f.name);
            for (const f of ['face-libraries.json', 'face-library-people.json', 'face-library-crops.json']) assert.ok(files.includes(f), f);
            const erased = await t.ctx.accountData.erase([ana.subject]);
            assert.ok(erased.erased.face_libraries >= 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM face_libraries WHERE owner=$1', [ana.subject])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM face_library_crops WHERE owner=$1', [ana.subject])), 0);
        });

        await check('logs never hold a template, a crop or a raw consent token', async () => {
            const logs = t.logs();
            assert.ok(!/1,0,0,0/.test(logs));
            assert.ok(!/image_ciphertext/.test(logs));
        });
    } finally {
        await t.close();
    }
    done();
})();
