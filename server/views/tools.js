'use strict';

/**
 * The three task pages: /find, /read and /watch (plan 2026-10-28 §5.8/§5.8b).
 *
 * Each page is one job: one input or drop zone, the result directly under it, and examples a person can tap.
 * Everything is a plain server-rendered form, so it works without JavaScript. The drop zone is the kit's (kit.drop):
 * kit-web.js adds drag and drop, paste and, on a phone, "Take a photo"; /read reads a picture as soon as it is chosen. Power options sit inside a <details> one tap down, and the API notes live at the
 * bottom of the page instead of above the tool.
 */
const { esc } = require('../render/html');
const kit = require('openvibe-shared/kit');

function n(value, fallback = 0) {
    const x = Number(value);
    return Number.isFinite(x) ? x : fallback;
}

function money(value) {
    const x = n(value);
    return `${x.toFixed(4)} USD`;
}

function when(ms) {
    const x = n(ms);
    return x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`;
}

function confidence(value) {
    if (value == null) return null;
    const x = Number(value);
    if (!Number.isFinite(x)) return null;
    return `${(x <= 1 ? x * 100 : x).toFixed(1)}%`;
}

/** What an answer took, for kit.receipt: the engine, the time, the cost (free when it was), and what is kept. */
function took(receipt, kept) {
    const cost = n(receipt.cost_usd);
    return [['Read by', receipt.model || receipt.engine || 'local'], ['Time', receipt.ms != null ? kit.num(receipt.ms, 'ms') : null], ['Cost', cost > 0 ? kit.num(cost, 'money') : 'free'], ['Kept', kept]];
}

function facts(items) {
    return `<dl class="vi-facts vi-tool-facts">${items.filter((x) => x && x[1] != null && x[1] !== '').map(([dt, dd]) => `<div><dt>${esc(dt)}</dt><dd>${dd}</dd></div>`).join('')}</dl>`;
}

function header({ kicker, title, lede }) {
    return `<header class="vi-page-h vi-tool-h"><p class="vi-kicker">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="vi-lede">${esc(lede)}</p></header>`;
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,image/avif';
/** The picture's way in (kit.drop): choose, drop, paste, or take a photo on a phone. auto: send the form at once. */
const dropZone = ({ id, name = 'image', label = 'Drop a picture here', hint = 'or choose a file', auto = false }) =>
    kit.drop({ id, name, accept: ACCEPT, label, hint, camera: true, auto });

function examples(links) {
    return `<div class="vi-examples"><span class="vi-examples-label">Try an example</span>${links.join('')}</div>`;
}

function apiNote({ children }) {
    return `<details class="vi-api"><summary>Use this from the API</summary><div class="vi-api-body">${children}</div></details>`;
}

function problemNote(problem) {
    return problem ? `<p class="vi-note is-bad" role="alert">${esc(problem)}</p>` : '';
}

// ── Find ─────────────────────────────────────────────────────

function find({ signedIn = false, q = '', result = null, problem = null, byImage = false } = {}) {
    const examplesHtml = examples([
        ['red bike by the pier', 'a dog on the sofa', 'the receipt from the market'].map((text) => `<a class="vi-example" href="/find?q=${encodeURIComponent(text)}">${esc(text)}</a>`).join(''),
    ]);
    const form = `<form class="vi-tool-form" id="vi-find-form" method="get" action="/find" role="search">
<label class="vi-field" for="vi-find-q"><span>Describe a picture you have</span></label>
<div class="vi-searchrow">
<input id="vi-find-q" name="q" type="search" value="${esc(q)}" placeholder="red bike by the pier" autocomplete="off" enterkeyhint="search" maxlength="500">
<button class="vi-btn" type="submit">Find it</button>
</div>
<p class="vi-fine">Words, not a hashtag. Vision compares your words with the pictures you have already added.</p>
</form>`;

    let resultHtml;
    if (!signedIn) {
        resultHtml = `<section class="vi-result-tool vi-result-empty" id="vi-find-empty">
<h2>Your own pictures, never a public index</h2>
<p>Sign in to search the pictures you have added to Vision from Pics, Media or Search. Nobody else can see the query or the matches.</p>
<p><a class="vi-btn" href="/auth/login?next=%2Ffind">Sign in with OpenVibe</a></p>
<p class="vi-fine">No account needed to <a href="/read">read a picture</a> or <a href="/watch">watch a still</a>.</p>
</section>`;
    } else if (result) {
        const rows = Array.isArray(result.results) ? result.results : [];
        const receipt = result.receipt || {};
        resultHtml = `<div id="vi-find-result">${kit.receipt({
            title: rows.length ? `${rows.length} ${rows.length === 1 ? 'match' : 'matches'} ${byImage ? 'by picture' : 'by words'}` : 'No matches yet',
            body: `\${rows.length ? \`<ol class="vi-matches">\${rows.slice(0, 30).map((m, i) => \`<li class="vi-match">
<span class="vi-match-rank" aria-hidden="true">\${i + 1}</span>
<span class="vi-match-main">\${m.result_url ? \`<a href="\${esc(m.result_url)}" rel="noopener">Open this picture</a>\` : \`<b>Picture \${esc(m.item_id)}</b>\`}<small>\${esc(m.item_id)}</small></span>
<span class="vi-match-score">\${Math.round(n(m.score) * 100)}%</span>
</li>\`).join('')}</ol>\` : \`<p>Nothing in your pictures matches those words yet. Add pictures from <a href="https://openvibe.media">Pics or Media</a>, then search again.</p><p class="vi-fine">Your matches stay private; index entries are tied to your account.</p>\`}<p class="vi-fine">${esc(receipt.retention || 'Only your own indexed pictures are searched; the query is not stored.')}</p>`,
            facts: took(receipt, 'not stored'),
        })}</div>`;
    } else {
        resultHtml = `<section class="vi-result-tool vi-result-empty" id="vi-find-empty">
<h2>Your matches appear here</h2>
<p>Start with a few words. Vision looks only at the pictures you have added and returns private links, with the score and the time it took.</p>
<p class="vi-fine">Searches are private. Vision keeps no public picture index and never identifies people in your photos.</p>
</section>`;
    }

    const byImageForm = signedIn ? `<details class="vi-disclose"><summary>Or find by another picture</summary>
<form class="vi-form" method="post" action="/find" enctype="multipart/form-data">
${dropZone({ id: 'vi-find-file', label: 'Drop the picture to match', hint: 'or choose a file' })}
<div class="vi-actions"><button class="vi-btn vi-btn-quiet" type="submit">Find similar pictures</button></div>
</form></details>` : '';

    return `<div class="vi-wrap vi-tool" id="vi-find">
${header({ kicker: 'Find · private', title: 'Find a picture by words', lede: 'Search only your own pictures. Describe what you remember; no public index, no stranger identification.' })}
${problemNote(problem)}
${form}
${examplesHtml}
${resultHtml}
${byImageForm}
${apiNote({ children: `<p class="vi-fine">Pics, Media and Search call <code>POST /api/v1/index</code> to add a picture, then <code>GET /api/v1/find?q=</code> or <code>POST /api/v1/find</code> with an image. A person needs their own Network token; the owner is checked on every read.</p>` })}
</div>`;
}

// ── Read ─────────────────────────────────────────────────────

function readView({ signedIn = false, ai = false, problem = null, result = null, values = {} } = {}) {
    const v = { lang: 'eng', ...values };
    let resultHtml;
    if (result) {
        const conf = confidence(result.confidence);
        // The reading first, then one quiet line of what it took (kit.receipt); a copy button when there is text.
        const pct = result.confidence == null ? null : Number(result.confidence) <= 1 ? Number(result.confidence) * 100 : Number(result.confidence);
        const cost = n(result.cost_usd);
        const said = String(result.reason || 'The local reader answered first');
        const reason = `${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? '' : '.'}`;
        const copy = result.text ? `<button type="button" class="ovk-icon-btn" data-ovk-copy="#vi-ocr-text" aria-label="Copy the text" title="Copy the text" hidden>${kit.icon('copy')}</button>` : '';
        resultHtml = `<div id="vi-read-result">${kit.receipt({
            title: 'What it says', actions: [copy],
            body: `<pre class="vi-ocr-text" id="vi-ocr-text" tabindex="0">${esc(result.text || 'No text was found in this picture.')}</pre><p class="vi-fine">${esc(reason)}</p>`,
            facts: [
                ['Read by', `${/tesseract/i.test(String(result.model || '')) ? 'Tesseract 5' : (result.model || result.engine || 'Tesseract 5')}${result.engine === 'ai' ? ' (AI fallback)' : ''}`],
                ['Confidence', conf && Number.isFinite(pct) ? { html: `${kit.meter({ value: pct, label: 'Confidence', text: conf })}${esc(conf)}` } : null],
                ['Time', kit.num(result.latency_ms || result.ms, 'ms')],
                ['Cost', cost > 0 ? kit.num(cost, 'money') : 'free'],
                ['Kept', signedIn && result.id ? { html: `<a href="/a/${encodeURIComponent(result.id)}">in your answers</a>` } : 'not stored'],
            ],
        })}</div>`;
    } else {
        resultHtml = '';
    }
    return `<div class="vi-wrap vi-tool" id="vi-read">
${header({ kicker: 'Read · local first', title: 'Read the words in a picture', lede: 'Receipts, signs, screenshots and labels: the words come back in reading order. Read on this host, free, and the picture is not stored.' })}
${problemNote(problem)}
<form class="vi-tool-form" id="vi-read-form" method="post" action="/read#vi-read-result" enctype="multipart/form-data">
${dropZone({ id: 'vi-read-file', label: 'Choose a picture to read', hint: 'or drop or paste one · read as soon as it is chosen', auto: true })}
${examples([`<button class="vi-example" type="submit" name="example" value="receipt">A shop receipt</button>`, `<button class="vi-example" type="submit" name="example" value="sign">A station sign</button>`])}
<div class="vi-actions"><button class="vi-btn" type="submit">Read it</button><a class="vi-btn vi-btn-quiet" href="/ask">Ask about it instead</a></div>
<details class="vi-options"><summary>Language and AI fallback</summary>
<div class="vi-field-grid">
<label class="vi-field"><span>Language</span><input name="lang" type="text" value="${esc(v.lang)}" maxlength="15" pattern="[a-z]{3}(\\+[a-z]{3}){0,3}"></label>
</div>
<label class="vi-check"><input type="checkbox" name="fallback" value="1"><span>If the local reader finds no text, ask OpenVibe.AI${signedIn ? '' : ' (needs a sign-in)'}</span></label>
<p class="vi-fine">${ai ? 'The fallback runs only after the local pass, and only for a signed-in account.' : 'The AI fallback is off on this host; the local reader still works.'}</p>
</details>
</form>
${resultHtml}
${apiNote({ children: `<p class="vi-fine">Food calls <code>POST /api/v1/receipt</code> for store, line items and total. Plain text is <code>POST /api/v1/ocr</code>, with <code>fallback=1</code> only when a signed-in person asks for it.</p>` })}
</div>`;
}

// ── Watch ────────────────────────────────────────────────────

const WATCH_CLASSES = [
    ['package', 'A package'], ['delivery', 'A delivery'], ['person', 'A person'],
    ['dog', 'A dog'], ['cat', 'A cat'], ['car', 'A car'],
];

function watchView({ problem = null, result = null, values = {} } = {}) {
    const selected = new Set((values.classes && values.classes.length ? values.classes : ['package', 'delivery']).map(String));
    const choices = WATCH_CLASSES.map(([value, label]) => `<label class="vi-choice"><input type="checkbox" name="classes" value="${esc(value)}"${selected.has(value) ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('');
    let resultHtml;
    if (result) {
        const list = Array.isArray(result.detections) ? result.detections : [];
        const receipt = result.receipt || {};
        resultHtml = `<div id="vi-watch-result">${kit.receipt({
            title: list.length ? `${list.length} ${list.length === 1 ? 'thing' : 'things'} found` : 'Nothing from your list',
            body: `\${list.length ? \`<ul class="vi-findings-list">\${list.map((d) => \`<li><b>\${esc(d.class)}</b><span>\${confidence(d.confidence) ? \`\${esc(confidence(d.confidence))} confidence\` : 'detected'}</span>\${d.box ? \`<small>box \${Math.round(Number(d.box.xmin) || 0)}, \${Math.round(Number(d.box.ymin) || 0)} to \${Math.round(Number(d.box.xmax) || 0)}, \${Math.round(Number(d.box.ymax) || 0)}</small>\` : ''}</li>\`).join('')}</ul>\` : '<p>No watched object was found in this still. Try a closer picture, or add another thing to watch for.</p>'}<p class="vi-fine">Vision finds the classes you chose; it does not identify people.</p>`,
            facts: took(receipt, 'not stored'),
        })}</div>`;
    } else {
        resultHtml = `<section class="vi-result-tool vi-result-empty" id="vi-watch-empty">
<h2>What Vision sees appears here</h2>
<p>Drop a still from your camera. Vision names the things on your list, with a confidence for each, and says how long it took.</p>
<p class="vi-fine">This is object detection, not face recognition. There is no template and no tracking identity.</p>
</section>`;
    }
    return `<div class="vi-wrap vi-tool" id="vi-watch">
${header({ kicker: 'Watch · local', title: 'Watch a camera still', lede: 'Drop a still and see what is there: a delivery, a package, a person or a car. Runs on this host, and the picture is not stored.' })}
${problemNote(problem)}
<form class="vi-tool-form" id="vi-watch-form" method="post" action="/watch#vi-watch-result" enctype="multipart/form-data">
${dropZone({ id: 'vi-watch-file', label: 'Drop a camera still', hint: 'a photo or screenshot' })}
<fieldset class="vi-choices"><legend>What are you watching for?</legend>${choices}</fieldset>
<div class="vi-actions"><button class="vi-btn" type="submit">Check this still</button><a class="vi-btn vi-btn-quiet" href="/read">Read it instead</a></div>
<details class="vi-options"><summary>Scene change and weather</summary>
<div class="vi-field-grid">
<label class="vi-field"><span>Previous still (for scene change)</span><input type="file" name="previous_image" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,image/avif"></label>
<label class="vi-check"><input type="checkbox" name="classes" value="snow"${selected.has('snow') ? ' checked' : ''}><span>Snow</span></label>
<label class="vi-check"><input type="checkbox" name="classes" value="scene change"${selected.has('scene change') ? ' checked' : ''}><span>Scene change</span></label>
</div>
<p class="vi-fine">A scene change compares this still with the previous one. Snow and delivery use a local scene check.</p>
</details>
</form>
${resultHtml}
${apiNote({ children: `<p class="vi-fine">Cam calls <code>POST /api/v1/watch</code> with an owner token, an image and up to 20 <code>classes</code>; send <code>previous_image</code> for a scene change. The API returns detections with class, confidence and box, plus a receipt for the engine, time and cost.</p>` })}
</div>`;
}

module.exports = { find, readView, watchView };
