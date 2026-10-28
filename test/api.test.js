'use strict';
/**
 * The JSON API: local OCR first, an AI answer with provenance and noLooks, a side-by-side compare, the UI check,
 * service tokens per capability, public model hints and benchmarks, and the problem+json refusals.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');
    const other = t.network.addUser('sam');
    const png = await t.textImage('TOTAL 5.50');

    try {
        await check('POST /ocr answers locally with text, confidence, zero cost and no AI run', async () => {
            const r = await t.get('/api/v1/ocr', { multipart: { image: png } });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.strictEqual(b.task, 'ocr');
            assert.match(b.text, /TOTAL 5\.50/);
            assert.strictEqual(b.answer.engine, 'local');
            assert.strictEqual(b.model, 'tesseract');
            assert.strictEqual(Number(b.cost_usd), 0);
            assert.ok(b.answer.confidence > 0);
            assert.ok(Array.isArray(b.answer.words));
            assert.strictEqual(t.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').length, 0);
        });

        await check('POST /ask: a read question is answered by local OCR, a describe question by AI', async () => {
            const read = await t.get('/api/v1/ask', { multipart: { fields: { question: 'What does the receipt say?' }, image: png } });
            assert.strictEqual(read.status, 201, read.text);
            assert.strictEqual(read.json().answer.engine, 'local');
            assert.match(read.json().answer.text, /TOTAL 5\.50/);
            assert.strictEqual(t.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').length, 0);

            const described = await t.get('/api/v1/ask', { as: user, multipart: { fields: { task: 'describe', question: 'What is this?' }, image: png } });
            assert.strictEqual(described.status, 201, described.text);
            const a = described.json().answer;
            assert.strictEqual(a.answer.engine, 'ai');
            assert.strictEqual(a.provider, 'mock');
            assert.strictEqual(a.model, 'mock-vision-one');
            assert.match(a.reason, /OpenVibe\.AI routed/);
            assert.match(a.text, /red bicycle/);
            assert.ok(t.aiServer.requests.some((x) => x.path === '/v1/chat/completions' && JSON.stringify(x.body).includes('image_url')));
        });

        await check('POST /describe is the plan\'s operation name for the same ask, and a data URL works', async () => {
            const r = await t.get('/api/v1/describe', { as: user, json: { question: 'What is this?', image: `data:image/png;base64,${png.toString('base64')}` } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().answer.task, 'describe');
            assert.strictEqual(r.json().answer.answer.engine, 'ai');
        });

        await check('an anonymous describe is refused but an anonymous read question is local', async () => {
            const no = await t.get('/api/v1/ask', { multipart: { fields: { task: 'describe', question: 'What is this?' }, image: png } });
            assert.strictEqual(no.status, 401);
            assert.strictEqual(no.json().code, 'token.required');
            const ok = await t.get('/api/v1/ask', { multipart: { fields: { question: 'What does it say?' }, image: png } });
            assert.strictEqual(ok.status, 201);
            assert.strictEqual(ok.json().answer.engine, 'local');
        });

        await check('the AI answer is passed through noLooks even when the model names looks', async () => {
            t.aiServer.setText('A shirtless man in a kitchen laughs.');
            const r = await t.get('/api/v1/ask', { as: user, multipart: { fields: { task: 'describe', question: 'What happens?' }, image: png } });
            assert.strictEqual(r.status, 201);
            assert.match(r.json().answer.text, /without describing anyone's appearance/);
            assert.ok(!/shirtless/.test(r.json().answer.text));
            const sent = t.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').pop();
            assert.match(JSON.stringify(sent.body), /Never describe a person's body/);
        });

        await check('POST /compare runs local and AI, reports requested vs answered model, cost and latency', async () => {
            const r = await t.get('/api/v1/compare', { as: user, multipart: { fields: { question: 'Read and describe this image.', models: ['mock:one', 'mock:two'] }, image: png } });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.strictEqual(b.compare.length, 3);
            assert.strictEqual(b.compare[0].engine, 'local');
            assert.strictEqual(b.compare[0].cost_usd, 0);
            assert.ok(b.compare.every((x) => Number.isFinite(x.latency_ms)));
            assert.strictEqual(b.compare[1].requested_model, 'mock:one');
            assert.strictEqual(b.compare[1].model, 'mock:one');
            assert.strictEqual(b.answer.engine, 'compare');
            assert.ok(b.answer.answer.samples.length === 3);
        });

        await check('the UI check finds a planted overflow and low contrast as JSON', async () => {
            const html = '<style>body{background:#fff;color:#999}.wide{width:1600px}</style><div class="wide">wide</div><p>low contrast</p>';
            const r = await t.get('/api/v1/ui-check', { json: { html, viewport: { w: 390, h: 844 } } });
            assert.strictEqual(r.status, 201, r.text);
            const c = r.json().check;
            assert.strictEqual(c.engine, 'static-html');
            assert.strictEqual(c.viewport.w, 390);
            assert.ok(c.findings.some((f) => f.kind === 'overflow'));
            assert.ok(c.findings.some((f) => f.kind === 'contrast'));
            assert.ok(c.findings.every((f) => f.kind && f.severity && f.selector && f.detail));
        });

        await check('a service token with vision.ui.check can call the UI check; one without it is 403', async () => {
            const good = t.network.serviceToken({ sub: 'svc:design', cap: ['vision.ui.check'] });
            const ok = await t.get('/api/v1/ui-check', { bearer: good, json: { html: '<div style="width:900px">x</div>', viewport: { w: 390, h: 844 } } });
            assert.strictEqual(ok.status, 201, ok.text);
            const bad = t.network.serviceToken({ sub: 'svc:design', cap: ['vision.ask'] });
            const no = await t.get('/api/v1/ui-check', { bearer: bad, json: { html: '<p>x</p>' } });
            assert.strictEqual(no.status, 403);
            assert.strictEqual(no.json().code, 'capability.denied');
        });

        await check('a service token with vision.ask can ask; the answer has no subject', async () => {
            const tok = t.network.serviceToken({ sub: 'svc:today', cap: ['vision.ask'] });
            const r = await t.get('/api/v1/ask', { bearer: tok, multipart: { fields: { task: 'describe', question: 'What is this?' }, image: png } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().answer.answer.engine, 'ai');
            const row = await t.ctx.s.db.maybe('SELECT subject, requester FROM vision_answers WHERE id = $1', [r.json().answer.id]);
            assert.strictEqual(row.subject, null);
            assert.strictEqual(row.requester, 'service:today');
        });

        await check('one saved answer is visible to its owner, not to another person, and to a service with the capability', async () => {
            const r = await t.get('/api/v1/ask', { as: user, multipart: { fields: { task: 'describe', question: 'What is this?' }, image: png } });
            const id = r.json().answer.id;
            assert.strictEqual((await t.get(`/api/v1/answers/${id}`, { as: user })).status, 200);
            assert.strictEqual((await t.get(`/api/v1/answers/${id}`, { as: other })).status, 404);
            const tok = t.network.serviceToken({ sub: 'svc:today', cap: ['vision.ask'] });
            assert.strictEqual((await t.get(`/api/v1/answers/${id}`, { bearer: tok })).status, 200);
        });

        await check('GET /models and /benchmarks expose hints and aggregates, never a subject', async () => {
            const m = await t.get('/api/v1/models');
            assert.strictEqual(m.status, 200);
            assert.strictEqual(m.json().ai, true);
            assert.ok(m.json().offered.some((x) => x.model === 'mock-vision-one'));
            assert.ok(m.json().local.includes('tesseract'));
            await t.get('/api/v1/compare', { as: user, multipart: { fields: { question: 'Describe it.', models: ['mock:one'] }, image: png } });
            const b = await t.get('/api/v1/benchmarks');
            assert.strictEqual(b.status, 200);
            assert.ok(b.json().benchmarks.some((x) => x.engine === 'local' && x.model === 'tesseract'));
            assert.ok(!b.text.includes(user.subject));
        });

        await check('an image URL is fetched through the public-address guard; a bad image is refused', async () => {
            const r = await t.get('/api/v1/ocr', { json: { image_url: `${t.images.url}/image.png` } });
            assert.strictEqual(r.status, 201, r.text);
            assert.match(r.json().text, /HELLO VISION/);
            const bad = await t.get('/api/v1/ocr', { json: { image: 'data:image/png;base64,AAAA' } });
            assert.strictEqual(bad.status, 400);
            assert.match(bad.json().code, /vision\.image/);
        });

        await check('problem+json is used for a malformed body, an invalid task and an unknown route', async () => {
            const bad = await t.get('/api/v1/ask', { as: user, body: '{', headers: { 'content-type': 'application/json' } });
            assert.strictEqual(bad.status, 400);
            assert.match(bad.headers.get('content-type'), /application\/problem\+json/);
            assert.strictEqual(bad.json().code, 'request.malformed_json');
            const task = await t.get('/api/v1/ask', { as: user, json: { task: 'see', image: `data:image/png;base64,${png.toString('base64')}` } });
            assert.strictEqual(task.status, 400);
            assert.strictEqual(task.json().code, 'vision.invalid_task');
            const nope = await t.get('/api/v1/nope');
            assert.strictEqual(nope.status, 404);
            assert.strictEqual(nope.json().code, 'route.not_found');
        });
    } finally {
        await t.close();
    }
    done();
})();
