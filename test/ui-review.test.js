'use strict';
/**
 * The UI review panel (plan §AD.25; the owner, 11-17: "Interconnect openvibe.vision with openvibe.design and codes and
 * actor so that it can analyze interfaces and designs and improve and critique multi model multi harness configurable
 * modular"). One screenshot: the free pixel check, then up to three vision models at once, each alone with the picture,
 * the design rules and the checklist; the findings merged with how many critics saw each, ranked by severity and
 * agreement, each critic's cost and time beside it. A signed-out caller is refused; a critic that fails is said, not
 * hidden; the MCP tool answers the same.
 *   node test/ui-review.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const R = require('../server/vision/ui-review');

const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const RULES = [{ id: 'targets-44', rule: 'Everything you can press is at least 44 px.', area: 'phone' }, { id: 'no-spinners', rule: 'The only thing that goes round is the mark\'s own O.', area: 'motion' }, { id: 'one-db', rule: 'One database a service.', area: 'building' }];
const ONE = JSON.stringify({ works: ['The list reads well.'], findings: [
    { severity: 'medium', where: 'the Save button in the footer', rule: 'targets-44', says: 'The Save button in the footer is about 30 px tall.', fix: 'Make it 44 px tall.' },
    { severity: 'high', where: 'the loading area under the list', rule: 'no-spinners', says: 'A spinner turns under the list while it loads.', fix: 'Wait with the OpenVibe mark.' },
] });
const TWO = `Here is my review:\n${JSON.stringify({ works: [], findings: [
    { severity: 'high', where: 'footer Save button', rule: 'targets-44', says: 'The footer Save button is too small to press, about 30 px.', fix: 'Raise it to 44 px.' },
    { severity: 'low', where: 'the page title', rule: 'checklist', says: 'The title wraps onto three lines at this width.', fix: 'Shorten the title.' },
] })}\nThanks.`;

(async () => {
    await check('parse and merge: the same finding from two critics is one row, seen by both, ranked first among equals', async () => {
        assert.deepStrictEqual(R.parseFindings('no json here'), { ok: false, works: [], findings: [] });
        const two = R.parseFindings(TWO);
        assert.deepStrictEqual([two.ok, two.findings.length, two.findings[1].rule], [true, 2, 'checklist'], 'JSON inside prose is read');
        const merged = R.merge([{ model: 'one', findings: R.parseFindings(ONE).findings }, { model: 'two', findings: two.findings }]);
        assert.deepStrictEqual(merged.map((m) => [m.rule, m.severity, m.agreement]), [['targets-44', 'high', 2], ['no-spinners', 'high', 1], ['checklist', 'low', 1]]);
        assert.deepStrictEqual(merged[0].seen_by, ['one', 'two']);
        assert.deepStrictEqual(R.rulesFrom({ rules: RULES }).map((r) => r.id), ['targets-44', 'no-spinners'], 'a building rule is not a screen\'s');
        const p = R.promptFor({ rules: RULES, checks: [{ kind: 'low_contrast', detail: 'grey on grey in the footer' }], focus: 'the footer', viewport: { w: 390, h: 844 }, theme: 'dark' });
        assert.match(p, /a 390×844 px view, dark theme/);
        assert.match(p, /- targets-44: Everything you can press is at least 44 px\./);
        assert.match(p, /confirm or dismiss each from the picture:\n- low_contrast: grey on grey in the footer/);
        assert.match(p, /look especially at: the footer/);
        assert.match(p, /Answer with JSON only/);
    });

    const t = await boot();
    const user = t.network.addUser('reviewer-ana');
    const png = await t.textImage('SAVE');
    const image = `data:image/png;base64,${png.toString('base64')}`;
    try {
        await check('a screenshot reviewed by two critics at once: the gate, the panel, the merge, the cost', async () => {
            const prompts = [];
            t.aiServer.setText((model, prompt) => { prompts.push([model, prompt]); return model === 'mock:one' ? ONE : TWO; });
            const r = await t.get('/api/v1/ui-review', { as: user, json: { image, models: ['mock:one', 'mock:two'], rules: RULES, viewport: { w: 390, h: 844 }, theme: 'dark', focus: 'the footer' } });
            t.aiServer.setText(null);
            assert.strictEqual(r.status, 201, r.text);
            const v = r.json().review;
            assert.deepStrictEqual(v.panel.map((p) => [p.requested_model, p.ok, p.findings.length]), [['mock:one', true, 2], ['mock:two', true, 2]]);
            assert.ok(v.panel.every((p) => p.cost_usd > 0 && p.latency_ms >= 0));
            assert.strictEqual(v.cost_usd, Math.round((v.panel[0].cost_usd + v.panel[1].cost_usd) * 1e6) / 1e6);
            assert.deepStrictEqual(v.merged.map((m) => [m.rule, m.agreement]), [['targets-44', 2], ['no-spinners', 1], ['checklist', 1]]);
            assert.ok(v.gate && Array.isArray(v.gate.findings), 'the pixel check ran first');
            assert.deepStrictEqual([v.viewport, v.theme, v.rules_checked], [{ w: 390, h: 844 }, 'dark', 2]);
            assert.strictEqual(prompts.length, 2);
            assert.ok(prompts.every(([, p]) => /targets-44/.test(p) && /JSON only/.test(p) && !/A spinner turns/.test(p)), 'each critic alone, never another\'s answer');
        });

        await check('Design\'s whole rule list reaches the model, its JSON form included (11-17: cut at 2000 characters, every critic answered in prose)', async () => {
            const many = Array.from({ length: 90 }, (_, i) => ({ id: `rule-${i}`, rule: `Rule number ${i}: something a screen must do, said in a long enough sentence to count.`, area: 'phone' }));
            const prompts = [];
            t.aiServer.setText((model, prompt) => { prompts.push(prompt); return ONE; });
            const v = (await t.get('/api/v1/ui-review', { as: user, json: { image, models: ['mock:one'], rules: many } })).json().review;
            t.aiServer.setText(null);
            assert.ok(prompts[0].length > 8000, `the prompt is ${prompts[0].length} characters`);
            assert.match(prompts[0], /rule-89: Rule number 89/, 'the last rule is there');
            assert.match(prompts[0], /Answer with JSON only/, 'and the answer\'s form after it');
            assert.match(prompts[0], /You are reviewing a screenshot[^\\]*one JSON object/, 'the form is named in the first sentence too');
            assert.strictEqual(v.panel[0].ok, true);
        });

        await check('a critic that fails is said, and the others still answer', async () => {
            t.aiServer.setText((model) => (model === 'mock:two' ? 'I cannot do JSON today.' : ONE));
            const v = (await t.get('/api/v1/ui-review', { as: user, json: { image, models: ['mock:one', 'mock:two'], rules: RULES } })).json().review;
            t.aiServer.setText(null);
            assert.deepStrictEqual(v.panel.map((p) => [p.ok, p.error]), [[true, null], [false, 'the model did not answer in the asked form']]);
            assert.strictEqual(v.merged.length, 2);
        });

        await check('signed out: refused; no screenshot: refused in words', async () => {
            const anon = await t.get('/api/v1/ui-review', { json: { image } });
            assert.ok(anon.status === 401 || anon.status === 403, `status ${anon.status}`);
            const none = await t.get('/api/v1/ui-review', { as: user, json: { models: ['mock:one'] } });
            assert.strictEqual(none.status, 400);
            assert.match(none.text, /send a screenshot/);
        });

        await check('MCP: vision.review_ui is listed and answers the same review', async () => {
            const list = (await t.get('/mcp', { as: user, json: rpc('tools/list') })).json().result.tools;
            assert.ok(list.some((x) => x.name === 'vision.review_ui'));
            t.aiServer.setText(ONE);
            const out = (await t.get('/mcp', { as: user, json: rpc('tools/call', { name: 'vision.review_ui', arguments: { image, models: ['mock:one'] } }) })).json().result;
            t.aiServer.setText(null);
            assert.strictEqual(out.isError, false, JSON.stringify(out));
            assert.deepStrictEqual(out.structuredContent.review.merged.map((m) => m.rule), ['no-spinners', 'targets-44']);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
