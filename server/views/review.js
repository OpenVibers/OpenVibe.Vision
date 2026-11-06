'use strict';

/**
 * The operator's unsafe-image review (VIS-6). One page lists the queue, one page shows a review and its
 * decision form. Everything is server-rendered and works without JavaScript. The three categories are the
 * only choices, written in plain words: fine (nudity included), sex acts or porn (never public), and sexual
 * content involving a minor (always blocked and reported to the operator). A category-3 row always shows its
 * operator report; nothing on this page reports anything outside OpenVibe.
 */
const { esc, time } = require('../render/html');

const PLAIN = {
    fine: 'Fine — OK to show, including nudity',
    sex_acts: 'Sex acts or porn — never public; kept for its owner',
    minor_sexual: 'Sexual content involving a minor — always blocked and reported to the operator',
};
const SHORT = { fine: 'Fine', sex_acts: 'Sex acts or porn', minor_sexual: 'Sexual content involving a minor' };
const ACTION = { fine: 'Nothing changes; it may be shown.', sex_acts: 'Hide it from every public surface; its owner keeps it.', minor_sexual: 'Block it everywhere, quarantine the object, and keep a report for the operator.' };

const thumb = (r) => (r.preview_url ? r.preview_url : '/img/eye.svg');

function badge(category) {
    return `<span class="vi-review-badge is-${esc(category)}">${esc(SHORT[category] || category)}</span>`;
}

function facts(r) {
    return `<dl class="vi-facts">
<div><dt>Category</dt><dd>${esc(SHORT[r.category] || r.category)}</dd></div>
<div><dt>Object</dt><dd>${esc(r.object_type)}${r.object_id ? ` <code>${esc(r.object_id)}</code>` : ''}</dd></div>
<div><dt>Owner</dt><dd>${r.owner_subject ? `<code>${esc(r.owner_subject)}</code>` : '—'}</dd></div>
<div><dt>Engine</dt><dd>${esc(r.engine)}${r.model ? ` · ${esc(r.model)}` : ''}</dd></div>
<div><dt>Time</dt><dd>${time(r.created_at)}</dd></div>
<div><dt>Image</dt><dd>${r.image_sha256 ? `<code>${esc(String(r.image_sha256).slice(0, 12))}…</code>` : 'not kept'}</dd></div>
</dl>`;
}

function queue({ reviews = [], counts = {}, category = null, saved = null, reports = [] } = {}) {
    const tab = (key, label, n) => `<a class="vi-review-tab${category === key ? ' is-on' : ''}" href="${key ? `/review?category=${key}` : '/review'}">${esc(label)} <span>${Number(n) || 0}</span></a>`;
    const row = (r) => `<li class="vi-review-row is-${esc(r.category)}" id="vi-review-${esc(r.id)}">
<a class="vi-review-pic" href="/review/${encodeURIComponent(r.id)}" aria-hidden="true" tabindex="-1"><img src="${thumb(r)}" alt="" width="96" height="72" loading="lazy"></a>
<div class="vi-review-main">
<div class="vi-review-head">${badge(r.category)}<span class="vi-review-plain">${esc(r.plain_words || PLAIN[r.category])}</span></div>
<p class="vi-review-obj">${esc(r.object_type)}${r.object_id ? ` · <code>${esc(r.object_id)}</code>` : ''}${r.owner_subject ? ` · owner <code>${esc(r.owner_subject)}</code>` : ''}</p>
<p class="vi-review-reason">${esc(r.reason || 'No reason was given.')}</p>
<p class="vi-review-meta">${esc(r.engine)}${r.model ? ` · ${esc(r.model)}` : ''} · ${time(r.created_at)}${r.report ? ` · <b>operator report ${esc(r.report.status)}</b>` : ''}${r.status === 'decided' ? ' · decided by staff' : ''}</p>
</div>
<a class="vi-btn vi-btn-small" href="/review/${encodeURIComponent(r.id)}">Review</a>
</li>`;
    const reportRow = (r) => `<li class="vi-report-row" id="vi-report-${esc(r.id)}"><b>${esc(SHORT[r.category] || r.category)}</b> <code>${esc(r.id)}</code> · ${esc(r.object_type)}${r.object_id ? ` <code>${esc(r.object_id)}</code>` : ''} · ${esc(r.status)} · ${time(r.created_at)} <a href="/review/${encodeURIComponent(r.review_id)}">Open review</a></li>`;
    return `<div class="vi-wrap vi-review" id="vi-review">
<header class="vi-page-h"><p class="vi-kicker">Operator review</p><h1>Unsafe-image review</h1>
<p class="vi-lede">Every image sorts into exactly three categories. Nudity is fine. Sex acts and porn are never public, and are kept for their owner. Anything sexual involving a minor is blocked, quarantined, and left as a report for the operator.</p></header>
${saved ? `<p class="vi-note" role="status">Saved. The review is now in the category you chose.</p>` : ''}
<nav class="vi-review-tabs" aria-label="Review categories">
${tab(null, 'All reviews', counts.total)}
${tab('fine', 'Fine', counts.fine)}
${tab('sex_acts', 'Sex acts or porn', counts.sex_acts)}
${tab('minor_sexual', 'Sexual content involving a minor', counts.minor_sexual)}
</nav>
<p class="vi-review-rules"><b>${Number(counts.reports_open) || 0} open operator report${Number(counts.reports_open) === 1 ? '' : 's'}.</b> A category-3 review has a report row; this service does not send anything outside OpenVibe. An external report needs the NCMEC registration the owner holds.</p>
${reviews.length ? `<ul class="vi-review-list">${reviews.map(row).join('')}</ul>` : '<div class="vi-empty"><h2>Nothing in this category</h2><p>New reviews appear here as services send images. Choose another tab or wait for the next review.</p></div>'}
${reports.length ? `<section class="vi-review-reports" aria-labelledby="vi-reports-h"><h2 id="vi-reports-h">Open operator reports</h2><ul class="vi-report-list">${reports.map(reportRow).join('')}</ul></section>` : ''}
</div>`;
}

function item({ review: r, saved = null, problem = null } = {}) {
    if (!r) return '<div class="vi-wrap vi-page-pad vi-narrow"><div class="vi-empty"><h1>No such review</h1><p>It may have been deleted, or the address was never one of ours.</p><a class="vi-btn" href="/review">Back to the queue</a></div></div>';
    const choice = (key) => `<label class="vi-review-choice${r.category === key ? ' is-on' : ''}">
<input type="radio" name="category" value="${key}"${r.category === key ? ' checked' : ''}>
<span><b>${esc(SHORT[key])}</b><small>${esc(PLAIN[key])}. ${esc(ACTION[key])}</small></span>
</label>`;
    return `<div class="vi-wrap vi-review vi-review-one" id="vi-review-one">
<header class="vi-page-h"><p class="vi-kicker"><a href="/review">Review queue</a> / one image</p><h1>${esc(SHORT[r.category] || r.category)}</h1>
<p class="vi-lede">${esc(r.plain_words || PLAIN[r.category] || '')}</p></header>
${saved ? '<p class="vi-note" role="status">Saved. The category is now what you chose.</p>' : ''}
${problem ? `<p class="vi-note is-bad" role="alert">${esc(problem)}</p>` : ''}
<article class="vi-review-detail">
<figure class="vi-review-figure"><img src="${thumb(r)}" alt="The image under review" width="480" height="360"><figcaption>${r.preview_url ? `<a href="${esc(r.preview_url)}" rel="noopener">Original preview</a>` : 'No preview link was supplied.'} The bytes are not stored by Vision.</figcaption></figure>
<div class="vi-review-detail-main">
<div class="vi-review-head">${badge(r.category)}<span class="vi-review-plain">${esc(r.plain_words || PLAIN[r.category] || '')}</span></div>
<p class="vi-review-reason">${esc(r.reason || 'No reason was given.')}</p>
${facts(r)}
${r.report ? `<section class="vi-review-report" id="vi-review-report"><h2>Operator report</h2><p><b>${esc(r.report.id)}</b> · ${esc(r.report.status)} · ${time(r.report.created_at)}</p><p>This is the record for the operator. Nothing is sent externally by this service; an external report needs the NCMEC registration the owner holds.</p></section>` : ''}
<form class="vi-review-form" method="post" action="/review/${encodeURIComponent(r.id)}/decide">
<fieldset class="vi-review-choices"><legend>Sort this image into one category</legend>
${choice('fine')}
${choice('sex_acts')}
${choice('minor_sexual')}
</fieldset>
<div class="vi-actions"><button class="vi-btn" type="submit">Save the category</button><a class="vi-btn vi-btn-quiet" href="/review">Back to the queue</a></div>
<p class="vi-fine">Saving a category records who decided it and when. Choosing a category other than “Sexual content involving a minor” dismisses this review’s open report, because the operator has decided the image is not that.</p>
</form>
</div>
</article>
</div>`;
}

function reports({ reports = [] } = {}) {
    const rows = reports.map((r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.object_type)}${r.object_id ? ` <code>${esc(r.object_id)}</code>` : ''}</td><td>${esc(r.status)}</td><td>${time(r.created_at)}</td><td><a href="/review/${encodeURIComponent(r.review_id)}">Open review</a></td></tr>`).join('');
    return `<div class="vi-wrap vi-review"><header class="vi-page-h"><p class="vi-kicker">Operator review</p><h1>Operator reports</h1><p class="vi-lede">Category-3 reviews make one report row each. They stay here until an operator decides the review.</p></header><div class="table-wrap"><table class="vi-table"><thead><tr><th scope="col">Report</th><th scope="col">Object</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col"></th></tr></thead><tbody>${rows || '<tr><td colspan="5">No reports.</td></tr>'}</tbody></table></div></div>`;
}

module.exports = { queue, item, reports, PLAIN, SHORT, ACTION };
