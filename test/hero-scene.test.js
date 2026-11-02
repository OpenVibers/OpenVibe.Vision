'use strict';
// The home's scene (MOTION-1): Read, Find and Watch as three steps the ghost cursor (openvibe-shared motion.js) taps
// in turn, each pane a result; Read is on without motion or JavaScript. On a phone the scene is content in the flow,
// never the room's faint corner decoration, and nothing in it is display:none.
//   node test/hero-scene.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const views = require('../server/views');

const html = views.home({}).body;
const scene = (html.match(/<div class="vi-scene"[\s\S]*?<\/div>\n<\/div>\n<\/div>/) || [''])[0];
assert.ok(scene, 'the hero carries the scene');
assert.match(scene, /data-ov-ghost[ >]/, 'the ghost cursor walks it');
assert.match(scene, /role="img" aria-label="Vision reads a receipt's total, finds your photo by words and spots a delivery on a camera"/);
const steps = [...scene.matchAll(/class="vi-sc-tab( is-on)?" data-ov-ghost-step="(\d)">(\w+)</g)].map((m) => [m[2], m[3], Boolean(m[1])]);
assert.deepStrictEqual(steps, [['1', 'Read', true], ['2', 'Find', false], ['3', 'Watch', false]], 'three steps, Read on');
['vi-sc-read', 'vi-sc-find', 'vi-sc-watch'].forEach((k) => assert.ok(scene.includes(`vi-sc-pane ${k}`), k));
assert.ok(!html.includes('vi-race'), 'the old motif is gone');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'vision.css'), 'utf8');
assert.match(css, /@media \(max-width: 759px\) \{ \.sc-room-pic:has\(\.vi-scene\) \{ position: static;[^}]*opacity: 1;/, 'in the flow on a phone, full strength');
assert.ok(!/\.vi-sc[\w-]*[^{]*\{[^}]*display:\s*none/.test(css), 'nothing in the scene is display:none');
assert.match(css, /\.vi-scene:has\(\[data-ov-ghost-step="2"\]\[data-ov-ghost-on\]\) \.vi-sc-find/, 'the chosen step shows its pane');
assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.vi-sc-pane, \.vi-sc-tab \{ transition: none; \} \}/);
console.log('hero scene: all checks passed');
