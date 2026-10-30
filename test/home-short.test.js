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
            assert.match(block, /<div class="pick-row" role="radiogroup" aria-label="What Vision does">/);
            const chips = [...block.matchAll(/<input type="radio" name="pick-scenes" id="pk-scenes-(vi-scene-\d+)" value="(vi-scene-\d+)"( checked)?><label for="pk-scenes-vi-scene-\d+">([^<]+)<\/label>/g)];
            assert.strictEqual(chips.length, 4, 'a chip per scene (' + chips.length + ')');
            assert.deepStrictEqual(chips.filter((m) => m[3]).map((m) => m[1]), [chips[0][1]], 'the first scene is picked');
            const scenes = [...block.matchAll(/<article class="sc-scene/g)];
            assert.strictEqual(scenes.length, chips.length, 'every scene is in the page');
            for (const m of chips) assert.ok(block.includes('id="' + m[1] + '"'), 'the pane of ' + m[1] + ' is in the page');
        });
        await check('the CSS guard: the chips are hidden and the scenes all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick:has\(#pk-scenes-vi-scene-0:checked\) #vi-scene-0\{display:block\}/, 'the rule that shows the picked scene');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'vision.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick \.pick-pane \{ display: none; \}/, 'the scenes are hidden on a phone');
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
