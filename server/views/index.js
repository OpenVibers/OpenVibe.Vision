'use strict';

/**
 * The Vision room's pages (plan 2026-10-28 §5.8). Server-rendered and whole without JavaScript: every action is
 * a plain form or link. public/css/vision.css and public/js/vision.js are one-comment placeholders the main
 * session replaces; the forms and results work without them. Ids and classes start with `vi-`.
 */
const { esc, time } = require('../render/html');
const sc = require('openvibe-shared/showcase');

const MODEL_LABEL = (a) => (a && a.model ? `${a.provider ? `${a.provider}:` : ''}${a.model}` : 'the local engine');

function motif() {
    return `<div class="vi-race" aria-hidden="true">
<svg class="vi-race-img" viewBox="0 0 420 260" preserveAspectRatio="none"><rect x="1" y="1" width="418" height="258" rx="18" fill="none" stroke="currentColor" stroke-opacity=".25"/><path d="M70 190 L150 120 L230 150 L350 70" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="70" cy="190" r="6" fill="currentColor"/><circle cx="150" cy="120" r="6" fill="currentColor"/><circle cx="230" cy="150" r="6" fill="currentColor"/><circle cx="350" cy="70" r="6" fill="currentColor"/></svg>
<span class="vi-race-box vi-race-a"><b>local OCR</b><small>0.0000 USD · 41 ms</small></span>
<span class="vi-race-box vi-race-b"><b>vision model</b><small>0.0007 USD · 1.2 s</small></span>
<span class="vi-race-tag">same image, two boxes</span>
</div>`;
}

function home({ signedIn = false, ai = false } = {}) {
    const tryIt = `<section class="vi-section vi-try" id="vi-try" aria-labelledby="vi-try-h">
<div class="vi-head-row"><h2 id="vi-try-h">Ask a picture</h2><span class="vi-count">${ai ? 'local OCR first, then OpenVibe.AI' : 'local engines only on this host right now'}</span></div>
<p class="vi-lede">Describe, read, translate, identify or count. Upload a file or paste a public image URL; the local reader answers a read question before any model is called.</p>
<div class="vi-actions"><a class="vi-btn" href="/ask">Ask a picture</a><a class="vi-btn vi-btn-quiet" href="/ocr">Read text only</a><a class="vi-btn vi-btn-quiet" href="/compare">Compare models</a><a class="vi-btn vi-btn-quiet" href="/ui-check">Check a page</a></div>
${signedIn ? '' : '<p class="vi-fine">Ask and compare save an answer to your account, so they need <a href="/auth/login?next=%2Fask">an OpenVibe sign-in</a>. OCR and the UI check work without one.</p>'}
</section>`;
    const room = sc.room({
        room: 'vision',
        hero: {
            title: 'See with the best model for the job',
            lede: 'Ask a picture. Read its text with a local OCR engine first. Compare the local reader with a routed vision model on the same image, with the cost and the time beside each answer. Check a page for overflow and layering faults. Local face tools use separate consent for each identifying purpose.',
            start: { href: '/ask', label: 'Ask a picture' },
            chips: [{ label: 'Read text', href: '/ocr' }, { label: 'Compare models', href: '/compare' }, { label: 'UI check', href: '/ui-check' }, { label: 'The API', href: '/developers' }],
            proof: [{ value: '0.0000', label: 'USD for the local OCR first pass' }],
            motif: motif(),
        },
        scenes: [
            {
                title: 'A receipt, read for nothing',
                text: 'The local reader (Tesseract, on this host) reads the words a receipt actually needs: merchant, date, lines, total. No image leaves the machine and no model is called. Only when the local pass finds no usable text does a signed-in person\'s AI fallback run, and the answer says so.',
                html: `<div class="vi-demo-receipt"><span class="vi-demo-kicker">LOCAL OCR</span><b>OPENVIBE MARKET</b><span>2026-10-28 · 14:02</span><span>Oat milk 3.40</span><span>Bread 2.10</span><strong>TOTAL 5.50</strong><small>confidence 91.4 · 0.0000 USD · 38 ms</small></div>`,
                action: { href: '/ocr', label: 'Read a picture' },
            },
            {
                title: 'The same image, side by side',
                text: 'A compare sends one image to the local reader and to OpenVibe.AI. AI\'s router is the authority: the provider and model shown are the ones that answered, never the hint. Cost comes from AI\'s own run, latency is measured here.',
                html: `<table class="vi-demo-table"><caption>one image, three answers</caption><thead><tr><th scope="col">engine</th><th scope="col">answer</th><th scope="col">cost</th><th scope="col">time</th></tr></thead><tbody><tr><td>local OCR</td><td>“TOTAL 5.50”</td><td>0.0000</td><td>38 ms</td></tr><tr><td>pool:fast</td><td>a receipt from a market</td><td>0.0004</td><td>1.1 s</td></tr><tr><td>pool:best</td><td>the total is 5.50</td><td>0.0012</td><td>2.4 s</td></tr></tbody></table>`,
                action: { href: '/compare', label: 'Run a compare' },
            },
            {
                title: 'The UI check catches the overflow',
                text: 'Drop in HTML, a page URL or a screenshot. The static pass reads the boxes and the colours: a container wider than the viewport, nowrap text clipped by its box, body text under 4.5:1, positioned boxes on top of each other, a z-index with no effect. Arena calls the same API after it generates a page.',
                html: `<div class="vi-demo-check"><div class="vi-demo-page"><span class="vi-demo-overflow">this card is 1400px wide</span><span class="vi-demo-clip">a headline that gets cut off at the edge</span></div><ul><li class="is-bad"><b>overflow</b><span>1400px in a 390px view</span></li><li class="is-bad"><b>cut off</b><span>nowrap inside 120px</span></li><li class="is-bad"><b>contrast</b><span>2.4:1, needs 4.5:1</span></li></ul></div>`,
                action: { href: '/ui-check', label: 'Check a page' },
            },
        ],
        faq: { items: [
            ['Does Vision recognise faces?', 'Only for a person who separately opts into a specific purpose: self verification, self search, cast tagging or private library grouping. Detect and blur never identify anyone. Public AI text never describes a person\'s looks.'],
            ['Which model answers?', 'Every answer names the model and provider that actually answered and the reason it was chosen. Local OCR is first for a read question; otherwise OpenVibe.AI routes the run and its provenance is what Vision reports.'],
            ['Are my images stored?', 'General answers keep no image bytes. An opt-in face library stores encrypted uploads and vectors privately; turning its purposes off erases derived data. Account export and deletion include those rows.'],
        ] },
    });
    const at = room.indexOf('<section class="sc-room-scenes"');
    return `<div class="vi-wrap vi-home" id="vi-home">${at < 0 ? room : room.slice(0, at) + tryIt + room.slice(at)}</div>`;
}

function signIn({ title, text, next }) {
    return `<div class="vi-wrap vi-page-pad vi-narrow"><div class="vi-empty" id="vi-sign-in"><h1>${esc(title)}</h1><p>${esc(text)}</p><a class="vi-btn" href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a></div></div>`;
}

function formError(message) {
    return `<div class="vi-wrap vi-page-pad vi-narrow"><div class="vi-empty" id="vi-form-error"><h1>That did not go through</h1><p>${esc(message)}</p><a class="vi-btn" href="/">Back to Vision</a></div></div>`;
}

function imageFields({ imageUrl = '', values = {} } = {}) {
    return `<div class="vi-field-grid">
<label class="vi-field"><span>Upload an image</span><input type="file" name="image" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,image/avif"></label>
<label class="vi-field"><span>…or a public image URL</span><input type="url" name="image_url" value="${esc(imageUrl || values.image_url || '')}" placeholder="https://openvibe.media/o/med_…" maxlength="2048"></label>
</div>`;
}

function ask({ signedIn = false, ai = false, problem = null, values = {} } = {}) {
    const v = { task: 'ask', mode: 'auto', ...values };
    return `<div class="vi-wrap" id="vi-ask">
<header class="vi-page-h"><p class="vi-kicker">Ask a picture</p><h1>What does the image show?</h1>
<p class="vi-lede">Describe, read, translate, identify or count. A read question goes to the local OCR reader first; the answer says which engine answered and why. Face matching has separate consent controls on <a href="/people">People</a>.</p></header>
${problem ? `<p class="vi-note is-bad" role="alert">${esc(problem)}</p>` : ''}
${signedIn ? '' : `<p class="vi-note">Ask saves the answer to an account. <a href="/auth/login?next=%2Fask">Sign in with OpenVibe</a> to ask; <a href="/ocr">OCR</a> and the <a href="/ui-check">UI check</a> work without one.</p>`}
${ai ? '' : '<p class="vi-note is-warm">OpenVibe.AI is not configured on this host. A read question still runs on the local OCR engine.</p>'}
<form class="vi-form vi-card" id="vi-ask-form" method="post" action="/ask" enctype="multipart/form-data">
${imageFields({ values: v })}
<div class="vi-field-grid">
<label class="vi-field"><span>Task</span><select name="task">
${[['ask', 'Ask a question'], ['describe', 'Describe the image'], ['identify', 'Identify what it is'], ['count', 'Count something'], ['translate', 'Read and translate'], ['ocr', 'Read the text']].map(([k, label]) => `<option value="${k}"${v.task === k ? ' selected' : ''}>${label}</option>`).join('')}
</select></label>
<label class="vi-field"><span>Mode</span><select name="mode">
${[['auto', 'Auto: cheapest engine first'], ['local', 'Local only: no model call'], ['ai', 'AI directly']].map(([k, label]) => `<option value="${k}"${v.mode === k ? ' selected' : ''}>${label}</option>`).join('')}
</select></label>
</div>
<label class="vi-field"><span>Question</span><input name="question" type="text" maxlength="2000" value="${esc(v.question || '')}" placeholder="What does the sign say? How many bottles are there?"></label>
<div class="vi-actions"><button class="vi-btn" type="submit"${signedIn ? '' : ' disabled'}>Ask</button><a class="vi-btn vi-btn-quiet" href="/ocr">Just read the text</a></div>
${signedIn ? '' : '<p class="vi-fine">The Ask button needs a signed-in account; the other pages do not.</p>'}
</form>
</div>`;
}

function ocr({ signedIn = false, ai = false, problem = null, result = null } = {}) {
    return `<div class="vi-wrap" id="vi-ocr">
<header class="vi-page-h"><p class="vi-kicker">Local first</p><h1>Read text from a picture</h1>
<p class="vi-lede">Tesseract 5 runs on this host. Nothing is sent to a model unless you are signed in, tick the fallback, and the local pass finds no usable text. The reading is stored as text; the image is not.</p></header>
${problem ? `<p class="vi-note is-bad" role="alert">${esc(problem)}</p>` : ''}
<div class="vi-two-col">
<form class="vi-form vi-card" id="vi-ocr-form" method="post" action="/ocr" enctype="multipart/form-data">
${imageFields()}
<label class="vi-field"><span>Language</span><input name="lang" type="text" value="eng" maxlength="15" pattern="[a-z]{3}(\\+[a-z]{3}){0,3}"></label>
<label class="vi-check"><input type="checkbox" name="fallback" value="1"><span>If the local reader finds no text, ask OpenVibe.AI${signedIn ? '' : ' (needs a sign-in)'}</span></label>
<div class="vi-actions"><button class="vi-btn" type="submit">Read locally</button><a class="vi-btn vi-btn-quiet" href="/ask">Ask a question instead</a></div>
${ai ? '' : '<p class="vi-fine">AI fallback is off on this host.</p>'}
</form>
${result ? `<aside class="vi-card vi-result" id="vi-ocr-result"><h2>Reading</h2><pre class="vi-ocr-text">${esc(result.text || 'No text was found.')}</pre><dl class="vi-facts"><div><dt>Engine</dt><dd>${esc(result.model || result.engine || 'local')}</dd></div><div><dt>Confidence</dt><dd>${result.confidence == null ? '—' : esc(result.confidence)}</dd></div><div><dt>Time</dt><dd>${Number(result.latency_ms) || 0} ms</dd></div><div><dt>Cost</dt><dd>${esc(Number(result.cost_usd) || 0)} USD</dd></div></dl><p class="vi-fine">${esc(result.reason || 'The local reader answered first.')}</p></aside>` : '<aside class="vi-card vi-result vi-muted" id="vi-ocr-empty"><h2>No image yet</h2><p>Upload a PNG, JPEG, WebP, GIF, BMP, TIFF or AVIF and press Read locally. The words come back in reading order.</p></aside>'}
</div>
</div>`;
}

function compare({ signedIn = false, ai = false, models = [], configured = [], problem = null, values = {} } = {}) {
    const v = { task: 'ask', ...values };
    const options = [];
    const seen = new Set();
    for (const m of [...models.map((x) => (x.provider && x.provider !== 'ai' ? `${x.provider}:${x.model || ''}` : (x.model || 'openvibe'))), ...configured]) {
        if (m && !seen.has(m)) { seen.add(m); options.push(m); }
    }
    if (!options.length) options.push('openvibe');
    return `<div class="vi-wrap" id="vi-compare">
<header class="vi-page-h"><p class="vi-kicker">Side by side</p><h1>Compare models on one image</h1>
<p class="vi-lede">The local OCR reader runs first and is free. Each AI hint is one OpenVibe.AI run; the provider and model that answer are the ones AI reports, never the hint. Cost and latency are measured per engine.</p></header>
${problem ? `<p class="vi-note is-bad" role="alert">${esc(problem)}</p>` : ''}
${signedIn ? '' : '<p class="vi-note">A compare spends an AI run, so it needs <a href="/auth/login?next=%2Fcompare">an OpenVibe sign-in</a>.</p>'}
${ai ? '' : '<p class="vi-note is-warm">OpenVibe.AI is not configured: a compare would show the local reader only.</p>'}
<form class="vi-form vi-card" id="vi-compare-form" method="post" action="/compare" enctype="multipart/form-data">
${imageFields({ values: v })}
<label class="vi-field"><span>Question</span><input name="question" type="text" maxlength="2000" value="${esc(v.question || '')}" placeholder="Read and describe this image."></label>
<label class="vi-field"><span>Task</span><select name="task">${[['ask', 'Ask'], ['describe', 'Describe'], ['ocr', 'Read'], ['count', 'Count'], ['identify', 'Identify'], ['translate', 'Translate']].map(([k, label]) => `<option value="${k}"${v.task === k ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
<fieldset class="vi-models"><legend>AI model hints <span class="vi-fine">(up to three; AI may route elsewhere)</span></legend>
${options.map((m) => `<label class="vi-check"><input type="checkbox" name="models" value="${esc(m)}" checked><span>${esc(m)}</span></label>`).join('')}
</fieldset>
<div class="vi-actions"><button class="vi-btn" type="submit"${signedIn ? '' : ' disabled'}>Compare on this image</button><a class="vi-btn vi-btn-quiet" href="/ask">Ask one model</a></div>
</form>
</div>`;
}

function uiCheck({ signedIn = false, problem = null, result = null, values = {} } = {}) {
    return `<div class="vi-wrap" id="vi-ui-check">
<header class="vi-page-h"><p class="vi-kicker">The UI check</p><h1>Find what a person would see</h1>
<p class="vi-lede">Overflow, cut-off text, low contrast, overlapping boxes and layering faults. Paste generated HTML, name a public page URL, or upload a screenshot. The static pass does not execute JavaScript and does not fetch remote stylesheets; it says so in the result.</p></header>
${problem ? `<p class="vi-note is-bad" role="alert">${esc(problem)}</p>` : ''}
<div class="vi-two-col">
<form class="vi-form vi-card" id="vi-ui-form" method="post" action="/ui-check" enctype="multipart/form-data">
<label class="vi-field"><span>HTML</span><textarea name="html" rows="10" maxlength="2000000" placeholder="&lt;!doctype html&gt;…">${esc(values.html || '')}</textarea></label>
<label class="vi-field"><span>…or a public page URL</span><input type="url" name="url" value="${esc(values.url || '')}" placeholder="https://openvibe.vision/" maxlength="2048"></label>
<div class="vi-field-grid">
<label class="vi-field"><span>…or a screenshot</span><input type="file" name="image" accept="image/*"></label>
<label class="vi-field"><span>Viewport width</span><input type="number" name="viewport_w" min="160" max="10000" value="${esc(values.viewport_w || 1280)}"></label>
<label class="vi-field"><span>Viewport height</span><input type="number" name="viewport_h" min="160" max="10000" value="${esc(values.viewport_h || 800)}"></label>
</div>
<div class="vi-actions"><button class="vi-btn" type="submit">Check it</button><a class="vi-btn vi-btn-quiet" href="/developers">Use the API</a></div>
<p class="vi-fine">${signedIn ? 'The result is saved to your account.' : 'The result is shown here and not saved. <a href="/auth/login?next=%2Fui-check">Sign in</a> to keep it.'}</p>
</form>
${result ? resultPanel(result) : '<aside class="vi-card vi-result vi-muted" id="vi-ui-empty"><h2>No page checked yet</h2><p>Start with a screenshot at 390 px wide, or paste a generated HTML document. Findings are returned as data: kind, severity, selector, detail and evidence.</p></aside>'}
</div>
</div>`;
}

function resultPanel(r) {
    return `<aside class="vi-card vi-result" id="vi-ui-result">
<h2>${esc(r.summary || (r.findings && r.findings.length ? `${r.findings.length} findings` : 'No faults found'))}</h2>
<dl class="vi-facts"><div><dt>Engine</dt><dd>${esc(r.engine || 'static-html')}</dd></div><div><dt>Viewport</dt><dd>${Number(r.viewport && r.viewport.w) || 0} × ${Number(r.viewport && r.viewport.h) || 0}</dd></div><div><dt>Findings</dt><dd>${Number(r.findings && r.findings.length) || 0}</dd></div><div><dt>Source</dt><dd>${esc(r.source || 'html')}</dd></div></dl>
${findingsTable(r.findings || [])}
${(r.warnings || []).length ? `<ul class="vi-warnings">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
</aside>`;
}

function findingsTable(findings = []) {
    if (!findings.length) return '<p class="vi-note is-good" role="status">No overflow, cut-off text, low contrast, overlap or layering fault was found by this pass.</p>';
    return `<div class="vi-table-wrap"><table class="vi-table" id="vi-findings"><thead><tr><th scope="col">Fault</th><th scope="col">Severity</th><th scope="col">Selector</th><th scope="col">What</th></tr></thead><tbody>${findings.slice(0, 200).map((f) => `<tr class="vi-finding vi-finding-${esc(f.kind)} is-${esc(f.severity)}"><td><b>${esc(f.kind)}</b></td><td>${esc(f.severity)}</td><td><code>${esc(f.selector)}</code></td><td>${esc(f.detail)}</td></tr>`).join('')}</tbody></table></div>`;
}

function answer({ a, mine = false } = {}) {
    const samples = a.answer && Array.isArray(a.answer.samples) ? a.answer.samples : null;
    const words = a.answer && Array.isArray(a.answer.words) ? a.answer.words : null;
    return `<div class="vi-wrap" id="vi-answer" data-answer="${esc(a.id)}">
<header class="vi-page-h"><p class="vi-kicker">${esc(a.task)} · ${mine ? 'yours' : 'staff view'}</p><h1>${esc(a.model ? MODEL_LABEL(a) : 'The local reader')}</h1>
${a.question ? `<p class="vi-question">${esc(a.question)}</p>` : ''}</header>
<section class="vi-answer-card vi-card">
${a.text ? `<pre class="vi-answer-text">${esc(a.text)}</pre>` : '<p class="vi-muted">No answer text was stored.</p>'}
<dl class="vi-facts">
<div><dt>Engine</dt><dd>${esc(a.answer && a.answer.engine ? a.answer.engine : 'local')}</dd></div>
<div><dt>Model</dt><dd>${esc(MODEL_LABEL(a))}</dd></div>
<div><dt>Why</dt><dd>${esc(a.reason || '—')}</dd></div>
<div><dt>Cost</dt><dd>${esc(Number(a.cost_usd) || 0)} USD</dd></div>
<div><dt>Time</dt><dd>${Number(a.latency_ms) || 0} ms</dd></div>
<div><dt>Image</dt><dd><code>${esc(a.image_sha256)}</code> · ${esc(a.image_mime)} · ${Number(a.image_bytes) || 0} bytes</dd></div>
<div><dt>Asked</dt><dd>${time(a.created_at)}</dd></div>
</dl>
</section>
${samples ? `<section class="vi-section" id="vi-compare-result"><h2>Side by side</h2><div class="vi-table-wrap"><table class="vi-table"><thead><tr><th scope="col">Engine</th><th scope="col">Requested</th><th scope="col">Answered by</th><th scope="col">Cost</th><th scope="col">Time</th><th scope="col">Answer</th></tr></thead><tbody>${samples.map((s) => `<tr><td>${esc(s.engine)}</td><td>${esc(s.requested_model || '—')}</td><td>${esc(s.model ? `${s.provider || ''}:${s.model}` : '—')}</td><td>${esc(Number(s.cost_usd) || 0)}</td><td>${Number(s.latency_ms) || 0} ms</td><td>${s.ok ? `<span class="vi-sample-text">${esc(s.text || '')}</span>` : `<span class="vi-note is-bad">${esc(s.error_code || 'failed')}</span>`}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
${words && words.length ? `<section class="vi-section" id="vi-words"><h2>Word boxes</h2><p class="vi-fine">${words.length} words with their confidence and position; the screenshot UI check uses the same boxes.</p><div class="vi-table-wrap"><table class="vi-table"><thead><tr><th scope="col">Word</th><th scope="col">Confidence</th><th scope="col">x, y</th><th scope="col">w × h</th></tr></thead><tbody>${words.slice(0, 200).map((w) => `<tr><td>${esc(w.text)}</td><td>${esc(w.conf)}</td><td>${Number(w.x) || 0}, ${Number(w.y) || 0}</td><td>${Number(w.w) || 0} × ${Number(w.h) || 0}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
<div class="vi-actions"><a class="vi-btn" href="/ask">Ask another</a><a class="vi-btn vi-btn-quiet" href="/compare">Compare models</a></div>
</div>`;
}

function uiCheckResult({ c, mine = false } = {}) {
    return `<div class="vi-wrap" id="vi-check" data-check="${esc(c.id)}">
<header class="vi-page-h"><p class="vi-kicker">UI check · ${mine ? 'yours' : 'staff view'}</p><h1>${esc(c.summary && c.summary.summary ? c.summary.summary : 'A UI check')}</h1>
<p class="vi-lede">${esc(c.engine)} · ${Number(c.viewport.w)} × ${Number(c.viewport.h)} · ${esc(c.source)}${c.url ? ` · <a href="${esc(c.url)}" rel="nofollow noopener">${esc(c.url)}</a>` : ''}</p></header>
${findingsTable(c.findings)}
${(c.summary && c.summary.warnings || []).length ? `<ul class="vi-warnings">${c.summary.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
<div class="vi-actions"><a class="vi-btn" href="/ui-check">Check another</a><a class="vi-btn vi-btn-quiet" href="/developers">Use the API</a></div>
</div>`;
}

function developers({ ai = false, models = [] } = {}) {
    const ep = (m, p, d) => `<div><dt><code>${esc(m)} ${esc(p)}</code></dt><dd>${d}</dd></div>`;
    return `<div class="vi-wrap" id="vi-developers">
<header class="vi-page-h"><p class="vi-kicker">Developers</p><h1>The Vision API</h1>
<p class="vi-lede">JSON under <code>/api/v1</code>, with <code>application/problem+json</code> errors. A person is the <code>vision_at</code> session cookie or a Network user token as a Bearer. A service token needs the capability on the route; Design's Arena calls the UI check with <code>vision.ui.check</code>.</p></header>
<section><h2>Ask, read, compare</h2><dl class="vi-eps">
${ep('POST', '/api/v1/ask (alias /api/v1/describe)', 'One image and a question: <code>{ task, question, mode, image_url }</code>, a multipart <code>image</code>, or an <code>image</code> data URL. Local OCR answers a read question first, otherwise OpenVibe.AI. Capability: <code>vision.ask</code>.')}
${ep('POST', '/api/v1/ocr', 'The local Tesseract reader. <code>fallback=1</code> asks AI only when no text is found and the caller is signed in or holds <code>vision.ocr</code>.')}
${ep('POST', '/api/v1/compare', 'The same image through local OCR and one to three AI hints (<code>models</code>). Returns each engine\'s answer, provider, model, cost and latency. Capability: <code>vision.compare</code>.')}
${ep('POST', '/api/v1/ui-check', 'HTML, URL or screenshot with <code>viewport</code>. Returns <code>findings</code>: overflow, cut_off, contrast, overlap and layering. Capability: <code>vision.ui.check</code>.')}
${ep('POST', '/api/v1/alt', 'Pics, Media and Chat send an image for short editable alt text. Capability: <code>vision.alt</code>.')}
${ep('POST', '/api/v1/index; GET or POST /api/v1/find', 'Media and Search index an owner image and find it by words or image. Requires the owner user token. Capability: <code>vision.find</code>.')}
${ep('POST', '/api/v1/receipt', 'Food sends a receipt image; Tesseract reads store, items and total first. Capability: <code>vision.receipt</code>.')}
${ep('POST', '/api/v1/product', 'Deals sends a product image for description, CLIP vector and configured offer candidates. Capability: <code>vision.product</code>.')}
${ep('POST', '/api/v1/watch', 'Cam sends an owner-provided still and watched classes. Requires the owner user token. Capability: <code>vision.watch</code>.')}
${ep('POST', '/api/v1/moments', 'Live or Media sends timestamped frames for scenes and candidate moments. Requires the owner user token. Capability: <code>vision.moments</code>.')}
${ep('GET', '/api/v1/answers/:id', 'One saved answer, for its owner or a service holding the route capability.')}
${ep('GET', '/api/v1/ui-checks/:id', 'One saved UI check, for its owner or a service holding <code>vision.ui.check</code>.')}
${ep('GET', '/api/v1/models', 'The AI route\'s offered provider:model hints and the local engine. No subject data.')}
${ep('GET', '/api/v1/benchmarks?task=&limit=', 'Aggregate compare samples: task, engine, provider, model, samples, mean latency and mean cost. No subject data.')}
</dl></section>
<section id="vi-faces"><h2>Faces, by consent</h2><dl class="vi-eps">
${ep('POST', '/api/v1/faces/detect', 'Anyone. YuNet boxes and a count; no template, identity or cross-frame tracking.')}
${ep('POST', '/api/v1/faces/blur', 'Anyone. The same YuNet boxes drive an image/png redaction. Both open routes are rate-limited.')}
${ep('GET', '/api/v1/faces/consents/text', 'The four signed texts and their versions. A person signs one purpose with <code>signed_name</code> and <code>text_version</code> at <code>POST /api/v1/faces/consents/:feature</code>; <code>DELETE</code> revokes and erases.')}
${ep('POST', '/api/v1/faces/enrol/:feature', 'A person, after that purpose\'s consent: exactly one face into an AES-GCM encrypted SFace template.')}
${ep('POST', '/api/v1/faces/verify', 'A person. Returns <code>{ score, match, threshold, liveness: "not_checked" }</code> against their own template, never an identity. A match alone unlocks nothing.')}
${ep('POST', '/api/v1/faces/media', 'A person with find or library consent. Stores an encrypted Vision upload; <code>GET /api/v1/faces/media/:id</code> is owner-only.')}
${ep('POST', '/api/v1/faces/find', 'A person with self-search consent. Matches only their own template in their own Vision uploads and returns private links.')}
${ep('POST', '/api/v1/faces/cast/match', 'Live with <code>vision.face.cast.match</code> and a signed <code>channel_id</code> claim. Reads only that channel\'s adult, consenting roster.')}
${ep('GET', '/api/v1/faces/cast/tags', 'A person\'s own cast tags; revoking a grant deletes them.')}
${ep('POST', '/api/v1/faces/library/cluster', 'A person with library consent in an allowed region. Private clusters; unknown faces stay unlabelled.')}
${ep('GET', '/api/v1/faces/library/groups', 'A person\'s own groups. No subject or public index.')}
${ep('POST', '/api/v1/faces/library/correct', 'A person\'s own group correction: <code>exclude</code>, <code>merge</code> or <code>split</code>.')}
</dl>
<p class="vi-fine"><a href="/people">Manage choices</a> · <a href="/people/privacy">Retention and privacy</a></p></section>
<section id="vi-capabilities"><h2>Capabilities and grants</h2>
<p class="vi-fine">Vision needs no new AI capability: outgoing calls are <code>ai.run.create</code> to OpenVibe.AI, audience <code>openvibe.ai</code>, namespace <code>ai.*</code>. The capabilities Vision offers are <code>vision.ask</code>, <code>vision.ocr</code>, <code>vision.compare</code>, <code>vision.ui.check</code> and <code>vision.face.cast.match</code>; the main session registers the manifests and grants them to Design (the Arena), Live (the cast roster) and any other caller.</p>
<pre class="vi-code">POST /api/v1/ui-check
Authorization: Bearer &lt;Network service token for openvibe.vision&gt;
Content-Type: application/json

{ "html": "&lt;!doctype html&gt;…", "viewport": { "w": 390, "h": 844 } }</pre>
</section>
<section id="vi-limits"><h2>What leaves this host</h2>
<p class="vi-fine">The local OCR engine, UI check and all face tools run on this host. Only an ask, compare or OCR fallback sends the normalised image to OpenVibe.AI; face images and templates never go there. General answers store no image bytes; opt-in face uploads are encrypted and private. Public AI text is passed through <code>noLooks</code>; a look-naming answer is replaced.</p>
<p class="vi-fine">AI on this host: ${ai ? 'configured' : 'not configured (local engines only)'}. Model hints: ${esc((models || []).join(', ') || 'from AI\'s routes at request time')}.</p>
</section>
<section id="vi-search"><h2>Search</h2><p class="vi-fine">v1 has no public objects: answers and UI checks belong to the caller and are not indexed, so Vision writes no Search document and has no outbox. The v2 Arena's public leaderboards are where public records will begin.</p></section>
</div>`;
}

function notFound() {
    return `<div class="vi-wrap vi-page-pad vi-narrow"><div class="vi-empty" id="vi-not-found"><p class="vi-kicker">404</p><h1>This answer is not here</h1><p>It may belong to another person, or the address was never one of ours.</p><a class="vi-btn" href="/">Back to Vision</a></div></div>`;
}

module.exports = {
    home, ask, ocr, compare, uiCheck, answer, uiCheckResult, developers, notFound, signIn, formError,
    resultPanel, findingsTable, motif,
};
