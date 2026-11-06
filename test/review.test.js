'use strict';
/**
 * VIS-6's last item: the unsafe-image review sorts into exactly three categories, and each one acts:
 *
 *   fine          allowed, including nudity — no report, public stays true
 *   sex_acts      hidden from public surfaces, kept for its owner — action hide, public false
 *   minor_sexual  blocked everywhere and quarantined, with an operator report row — action
 *                 quarantine_and_report, public false, report open
 *
 * Also: text alone is enough (Live's AI overviews), only staff may use the queue, an operator's decision
 * takes exactly one of the same three (never a fourth label), and the staff page shows the plain words.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const staff = t.network.addUser('ops', { role: 'admin' });
    const person = t.network.addUser('kim');
    const other = t.network.addUser('sam');
    const png = await t.textImage('A REVIEW FIXTURE');
    const reviewToken = () => t.network.serviceToken({ sub: 'svc:media', cap: ['vision.image.review'] });
    const readToken = () => t.network.serviceToken({ sub: 'svc:ops', cap: ['vision.review.read', 'vision.review.decide'] });

    try {
        await check('text alone: nudity is fine, sex acts are not, a child with nudity is the hard line', async () => {
            const fine = await t.get('/api/v1/review', { bearer: reviewToken(), json: { text: 'A nude figure drawing session; the model is naked on a bed.', object_type: 'live.clip', object_id: '9' } });
            assert.strictEqual(fine.status, 201, fine.text);
            assert.deepStrictEqual([fine.json().category, fine.json().action, fine.json().public], ['fine', 'allow', true]);
            assert.strictEqual(fine.json().review.engine, 'text');

            const sex = await t.get('/api/v1/review', { bearer: reviewToken(), json: { text: 'Two people having sex on a bed; pornographic footage.', object_type: 'live.clip', object_id: '10' } });
            assert.deepStrictEqual([sex.json().category, sex.json().action, sex.json().public], ['sex_acts', 'hide', false]);

            const minor = await t.get('/api/v1/review', { bearer: reviewToken(), json: { text: 'Two kids appear nude in the background.', object_type: 'community.paste', object_id: 'abc' } });
            assert.deepStrictEqual([minor.json().category, minor.json().action, minor.json().public], ['minor_sexual', 'quarantine_and_report', false]);
            assert.strictEqual(minor.json().report.status, 'open');
            assert.match(minor.json().plain_words, /always blocked/);
        });

        await check('an image is classified by OpenVibe.AI into the three categories, never a fourth', async () => {
            t.aiServer.setText('{"sexual": false, "minor": false, "sex_acts": false, "reason": "a figure drawing; nudity is allowed"}');
            let r = await t.get('/api/v1/review', {
                bearer: reviewToken(),
                multipart: { fields: { object_type: 'media.object', object_id: 'med_fine' }, image: png },
            });
            assert.strictEqual(r.status, 201, r.text);
            const fine = r.json();
            assert.deepStrictEqual([fine.category, fine.action, fine.public, fine.review.engine], ['fine', 'allow', true, 'ai']);
            assert.strictEqual(fine.report, null);
            assert.ok(t.aiServer.requests.some((x) => x.path === '/v1/chat/completions' && /sexual|sex acts/.test(JSON.stringify(x.body))));

            t.aiServer.setText('{"sexual": true, "minor": false, "sex_acts": true, "reason": "a sex act is visible"}');
            r = await t.get('/api/v1/review', {
                bearer: reviewToken(),
                multipart: { fields: { object_type: 'media.object', object_id: 'med_sex' }, image: png },
            });
            const sex = r.json();
            assert.deepStrictEqual([sex.category, sex.action, sex.public, sex.report], ['sex_acts', 'hide', false, null]);

            t.aiServer.setText('{"sexual": true, "minor": true, "sex_acts": true, "reason": "a child is shown in a sex act"}');
            r = await t.get('/api/v1/review', {
                bearer: reviewToken(),
                multipart: { fields: { object_type: 'media.object', object_id: 'med_hard' }, image: png },
            });
            const hard = r.json();
            assert.deepStrictEqual([hard.category, hard.action, hard.public], ['minor_sexual', 'quarantine_and_report', false]);
            assert.strictEqual(hard.report.status, 'open');
            assert.match(hard.report.id, /^vor_/);

            // A minor shown nude is the hard line even when the model does not call the picture a sex act.
            t.aiServer.setText('{"sexual": false, "nudity": true, "minor": true, "sex_acts": false, "reason": "a naked child"}');
            r = await t.get('/api/v1/review', {
                bearer: reviewToken(),
                multipart: { fields: { object_type: 'media.object', object_id: 'med_hard_nude' }, image: png },
            });
            assert.strictEqual(r.json().category, 'minor_sexual');
            assert.strictEqual(r.json().report.status, 'open');
        });

        await check('a stored review row keeps the category and one operator report for category 3', async () => {
            const row = await t.ctx.s.db.maybe("SELECT category, action, is_public FROM vision_image_reviews WHERE object_id = 'med_hard' ORDER BY created_at DESC LIMIT 1");
            assert.deepStrictEqual([row.category, row.action, row.is_public], ['minor_sexual', 'quarantine_and_report', false]);
            const reports = await t.ctx.s.db.many('SELECT status FROM vision_operator_reports');
            assert.ok(reports.length >= 2 && reports.every((x) => x.status === 'open'));
            const counts = (await t.get('/api/v1/review', { bearer: readToken() })).json().counts;
            assert.strictEqual(counts.minor_sexual, 3);
            assert.strictEqual(counts.sex_acts, 2);
            assert.ok(counts.fine >= 1);
            assert.ok(counts.reports_open >= 3);
        });

        await check('a person must be staff: the queue and a decision are refused, the owner can read their own review', async () => {
            const denied = await t.get('/api/v1/review', { as: person });
            assert.deepStrictEqual([denied.status, denied.json().code], [403, 'vision.staff_only']);
            const no = await t.get('/api/v1/review', { as: person, json: { text: 'a naked child' } });
            assert.strictEqual(no.status, 403);
            const tok = t.network.serviceToken({ sub: 'svc:media', cap: ['vision.image.review'] });
            const own = await t.get('/api/v1/review', { bearer: tok, json: { text: 'a naked man on a bed', object_type: 'community.paste', object_id: 'owner-read', owner_subject: person.subject } });
            const id = own.json().review.id;
            assert.strictEqual((await t.get(`/api/v1/review/${id}`, { as: person })).status, 200);
            assert.strictEqual((await t.get(`/api/v1/review/${id}`, { as: other })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/review/${id}`, { bearer: reviewToken() })).status, 403, 'image.review alone cannot read the queue');
            assert.strictEqual((await t.get(`/api/v1/review/${id}`, { bearer: readToken() })).status, 200);
        });

        await check('an operator decides with exactly one of the three; a fourth label is refused', async () => {
            const listed = (await t.get('/api/v1/review?category=minor_sexual', { bearer: readToken() })).json();
            const target = listed.reviews[0];
            const fourth = await t.get(`/api/v1/review/${target.id}/decide`, { bearer: readToken(), json: { category: 'nudity_is_fine' } });
            assert.deepStrictEqual([fourth.status, fourth.json().code], [400, 'vision.review_invalid_category']);
            const decided = await t.get(`/api/v1/review/${target.id}/decide`, { bearer: readToken(), json: { category: 'sex_acts' } });
            assert.strictEqual(decided.status, 200, decided.text);
            assert.deepStrictEqual([decided.json().category, decided.json().status, decided.json().report.status], ['sex_acts', 'decided', 'dismissed']);
        });

        await check('staff see the queue page with exactly the three plain categories; non-staff do not', async () => {
            const page = await t.get('/review', { as: staff });
            assert.strictEqual(page.status, 200, page.text);
            assert.ok(page.text.includes('Unsafe-image review'));
            assert.ok(page.text.includes('Fine — OK to show, including nudity'));
            assert.ok(page.text.includes('Sex acts or porn — never public; kept for its owner'));
            assert.ok(page.text.includes('Sexual content involving a minor — always blocked and reported to the operator'));
            assert.ok(!/category=nudity|category=other|category=maybe/.test(page.text));
            const denied = await t.get('/review', { as: person });
            assert.strictEqual(denied.status, 403);
            const signedOut = await t.get('/review');
            assert.strictEqual(signedOut.status, 401);
        });

        await check('the staff form saves one of the same three categories', async () => {
            const listed = (await t.get('/api/v1/review', { bearer: readToken() })).json();
            const target = listed.reviews.find((r) => r.category !== 'minor_sexual');
            const r = await t.get(`/review/${target.id}/decide`, { as: staff, form: { category: 'fine' } });
            assert.strictEqual(r.status, 303, r.text);
            const row = await t.ctx.s.db.maybe('SELECT category, status FROM vision_image_reviews WHERE id = $1', [target.id]);
            assert.deepStrictEqual([row.category, row.status], ['fine', 'decided']);
        });
    } finally {
        await t.close();
        done();
    }
})().catch((e) => { console.error(e); process.exit(1); });
