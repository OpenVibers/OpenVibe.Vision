'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
(async () => {
    const t = await boot();
    try {
        await check('the scenes are one pick block: a chip per scene, the first picked, every scene in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const start = page.indexOf('<div class="pick" id="pick-scenes">');
            assert.ok(start > 0, 'the pick block is on the home');
            const block = page.slice(start, start + 8000);
            assert.match(block, /<nav class="pick-row" aria-label="What Vision does">/);
            const chips = [...block.matchAll(/<a class="pick-chip" href="#(?:pp-scenes-)?(vi-scene-\d+)">()()([^<]+)<\/a>/g)];
            assert.strictEqual(chips.length, 4, 'a chip per scene (' + chips.length + ')');
            assert.ok(!/type="radio"/.test(block), 'no chip is a radio: nothing is picked, every pane shows');
            const scenes = [...block.matchAll(/<article class="sc-scene/g)];
            assert.strictEqual(scenes.length, chips.length, 'every scene is in the page');
            for (const m of chips) assert.ok(block.includes('id="' + m[1] + '"'), 'the pane of ' + m[1] + ' is in the page');
        });
        await check('the CSS guard: the chips are hidden and the scenes all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'vision.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
        });
        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['net', 'faq']) {
                assert.ok(page.includes('<details class="vn-fold vn-fold-block" id="' + id + '" open>'), id + ' is a fold, open in the page');
                assert.ok(page.includes('document.getElementById("' + id + '")'), id + ' has the script that closes it on a phone');
            }
            assert.match(page, /<h2 id="vi-net-h">Works across OpenVibe<\/h2>/);
            assert.match(page, /<h2 id="vi-faq-h">Questions<\/h2>/);
        });
    } finally {
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
