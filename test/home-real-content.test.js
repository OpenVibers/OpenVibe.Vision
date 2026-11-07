'use strict';
// The home's compare scene shows the measured public benchmark aggregates when there are any; when there are none it,
// the receipt and the UI check are labelled Example instead of presenting drawn numbers as measured results.
const assert = require('assert');
const views = require('../server/views');

const bench = [{ task: 'ocr', engine: 'ai', provider: 'openrouter', model: 'model-x', samples: 12, avg_latency_ms: 240, avg_cost_usd: 0.0004 }];
const measured = views.home({ benchmarks: bench }).body;
assert.ok(measured.includes('openrouter:model-x'), 'the real engine that answered');
assert.ok(measured.includes('12 samples') && measured.includes('ocr'), 'its real sample count and task');
assert.ok(measured.includes('$0.0004') && measured.includes('240 ms'), 'its real mean cost and time');
assert.ok(measured.includes('measured compare samples'), 'the table says it is measured data');
assert.ok(!measured.includes('pool:fast'), 'the drawn engines are gone when real ones exist');

const example = views.home({}).body;
assert.ok(example.includes('Example: one image, three answers'), 'the drawn table is labelled Example');
assert.ok(example.includes('Example · local OCR') && example.includes('example values · not a measured result'), 'the receipt is labelled Example');
assert.ok(example.includes('>Example</span>'), 'the UI check is labelled Example');
assert.ok(!example.includes('confidence 91.4'), 'no invented confidence');
assert.ok(!example.includes('read on this host · $0 · 38 ms'), 'no invented cost or time in the hero');
assert.ok(!example.includes('Your photo, July 12'), 'no invented date');

console.log('vision home: measured benchmarks when present, and every drawn number says Example');
