'use strict';

/**
 * The operator's unsafe-image review (VIS-6). One page lists the queue, one page shows a review and its
 * decision form. Everything is server-rendered and works without JavaScript. The three categories are the
 * only choices, written in plain words: fine (nudity included), sex acts or porn (never public), and sexual
 * content involving a minor (always blocked and reported to the operator).
 *
 * Category 2 and 3 pictures are not shown by default. A sex-act thumbnail is blurred in the queue; a
 * category-3 row has no picture at all. The detail page asks Media for a 60-second operator view only when
 * staff press Show, and every reveal is logged on the report. A category-3 picture must never be saved or
 * shared; it is evidence for the report.
 */
const { esc, time } = require('../render/html');

const PLAIN = {
    fine: 'Fine — OK to show, including nudity',
    sex_acts: 'Sex acts or porn — never public; kept for its owner',
    minor_sexual: 'Sexual content involving a minor — always blocked and reported to the operator',
};
const SHORT = { fine: 'Fine', sex_acts: 'Sex acts or porn', minor_sexual: 'Sexual content involving a minor' };
const ACTION = { fine: 'Nothing changes; it may be shown.', sex_acts: 'Hide it from every public surface; its owner keeps it.', minor_sexual: 'Block it everywhere, quarantine the object, and keep a report for the operator.' };

const preview = (r) => (r.preview_url ? String(r.preview_url) : null);
const mediaRef = (r) => (r.media_object_id || (r.object_type === 'media.object' ? r.object_id : null));
const evidenceWarn = 'This picture is evidence for the report: do not save it, copy it or share it. Vision keeps it only for the operator\'s review.';

function badge(category) {
    return `<span class="vi-review-badge is-${esc(category)}">${esc(SHORT[category] || category)}</span>`;
}

function queuePicture(r) {
    if (r.category === 'minor_sexual') return '<span class="vi-review-noimage">Picture withheld</span>';
    if (!preview(r)) return '<span class="vi-review-noimage">No preview</span>';
    return `<img class="vi-review-thumb${r.category === 'sex_acts' ? ' is-blurred' : ''}" src="${esc(preview(r))}" alt="" width="96" height="72" loading="lazy">`;
}

function evidenceFigure(r, revealed = null) {
    if (revealed) {
        return `<figure class="vi-review-figure"><img class="vi-review-evidence" src="${esc(revealed.url)}" referrerpolicy="no-referrer" alt="The picture under review, shown for this operator view"><figcaption>Shown for a 60-second operator view; this reveal is logged. ${esc(evidenceWarn)}</figcaption></figure>`;
    }
    if (r.category === 'fine' && preview(r)) {
        return `<figure class="vi-review-figure"><img class="vi-review-evidence" src="${esc(preview(r))}" alt="The picture under review"><figcaption>${r.preview_url ? `<a href="${esc(preview(r))}" rel="noopener noreferrer">Original preview</a>` : ''} The bytes are not stored by Vision.</figcaption></figure>`;
    }
    if (r.category === 'sex_acts' && preview(r)) {
        return `<figure class="vi-review-figure"><img class="vi-review-evidence is-blurred" src="${esc(preview(r))}" alt="The picture under review, blurred"><figcaption>Blurred until you choose Show. ${esc(evidenceWarn)}</figcaption></figure>`;
    }
    return `<figure class="vi-review-figure"><div class="vi-review-held" role="img" aria-label="Picture withheld">Picture withheld${r.category === 'minor_sexual' ? ' — quarantined as evidence' : ''}</div><figcaption>${r.category === 'minor_sexual' ? 'Media refuses even a signed read. Vision asks Media for a 60-second view only when you press Show.' : 'The picture is hidden from the public.'} ${esc(evidenceWarn)}</figcaption></figure>`;
}

function revealLog(r) {
    const rows = Array.isArray(r.reveals) ? r.reveals : [];
    if (!rows.length) return '';
    return `<section class="vi-review-reveals" aria-labelledby="vi-reveals-h"><h2 id="vi-reveals-h">Operator views</h2><ul>${rows.map((x) => `<li><b>${esc(x.operator_subject)}</b> · ${esc(x.kind === 'media_operator_view' ? 'Media operator view' : 'preview link')} · ${time(x.revealed_at)}${x.expires_at ? ` · until ${time(x.expires_at)}` : ''}</li>`).join('')}</ul><p class="vi-fine">Every Show is logged here for the report.</p></section>`;
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
<a class="vi-review-pic" href="/review/${encodeURIComponent(r.id)}" aria-hidden="true" tabindex="-1">${queuePicture(r)}</a>
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
<p class="vi-review-rules"><b>${Number(counts.reports_open) || 0} open operator report${Number(counts.reports_open) === 1 ? '' : 's'}.</b> Category 2 and 3 pictures are hidden or blurred here. A category-3 picture is evidence: do not save or share it, and open it only through Show on the review page, which is logged. This service does not send anything outside OpenVibe.</p>
${reviews.length ? `<ul class="vi-review-list">${reviews.map(row).join('')}</ul>` : '<div class="vi-empty"><h2>Nothing in this category</h2><p>New reviews appear here as services send images. Choose another tab or wait for the next review.</p></div>'}
${reports.length ? `<section class="vi-review-reports" aria-labelledby="vi-reports-h"><h2 id="vi-reports-h">Open operator reports</h2><ul class="vi-report-list">${reports.map(reportRow).join('')}</ul></section>` : ''}
</div>`;
}

function item({ review: r, saved = null, problem = null, revealed = null } = {}) {
    if (!r) return '<div class="vi-wrap vi-page-pad vi-narrow"><div class="vi-empty"><h1>No such review</h1><p>It may have been deleted, or the address was never one of ours.</p><a class="vi-btn" href="/review">Back to the queue</a></div></div>';
    const choice = (key) => `<label class="vi-review-choice${r.category === key ? ' is-on' : ''}">
<input type="radio" name="category" value="${key}"${r.category === key ? ' checked' : ''}>
<span><b>${esc(SHORT[key])}</b><small>${esc(PLAIN[key])}. ${esc(ACTION[key])}</small></span>
</label>`;
    const hidden = r.category !== 'fine';
    return `<div class="vi-wrap vi-review vi-review-one" id="vi-review-one">
<header class="vi-page-h"><p class="vi-kicker"><a href="/review">Review queue</a> / one image</p><h1>${esc(SHORT[r.category] || r.category)}</h1>
<p class="vi-lede">${esc(r.plain_words || PLAIN[r.category] || '')}</p></header>
${saved ? '<p class="vi-note" role="status">Saved. The category is now what you chose.</p>' : ''}
${problem ? `<p class="vi-note is-bad" role="alert">${esc(problem)}</p>` : ''}
<article class="vi-review-detail">
${evidenceFigure(r, revealed)}
<div class="vi-review-detail-main">
<div class="vi-review-head">${badge(r.category)}<span class="vi-review-plain">${esc(r.plain_words || PLAIN[r.category] || '')}</span></div>
<p class="vi-review-reason">${esc(r.reason || 'No reason was given.')}</p>
${facts(r)}
${hidden ? `<section class="vi-review-evidence-note" aria-labelledby="vi-evidence-h"><h2 id="vi-evidence-h">Evidence for the report</h2><p>${esc(evidenceWarn)}${r.category === 'minor_sexual' ? ' The object is quarantined; Media opens it only for this 60-second operator view.' : ' The object is hidden from every public surface.'}</p><form method="post" action="/review/${encodeURIComponent(r.id)}/reveal"><button class="vi-btn" type="submit">Show the picture</button><span class="vi-fine">One picture, for 60 seconds; this is logged.</span></form></section>` : ''}
${r.report ? `<section class="vi-review-report" id="vi-review-report"><h2>Operator report</h2><p><b>${esc(r.report.id)}</b> · ${esc(r.report.status)} · ${time(r.report.created_at)}</p><p>This is the record for the operator. Nothing is sent externally by this service; an external report needs the NCMEC registration the owner holds.</p></section>` : ''}
${revealLog(r)}
<form class="vi-review-form" method="post" action="/review/${encodeURIComponent(r.id)}/decide">
<fieldset class="vi-review-choices"><legend>Sort this image into one category</legend>
${choice('fine')}
${choice('sex_acts')}
${choice('minor_sexual')}
</fieldset>
<div class="vi-actions"><button class="vi-btn" type="submit">Save the category</button><a class="vi-btn vi-btn-quiet" href="/review">Back to the queue</a></div>
<p class="vi-fine">Saving a category records who decided it and when. Choosing a category other than “Sexual content involving a minor” releases Media's evidence hold and dismisses this review's open report, because the operator has decided the image is not that.</p>
</form>
</div>
</article>
</div>`;
}

function reports({ reports = [] } = {}) {
    const rows = reports.map((r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.object_type)}${r.object_id ? ` <code>${esc(r.object_id)}</code>` : ''}</td><td>${esc(r.status)}</td><td>${time(r.created_at)}</td><td><a href="/review/${encodeURIComponent(r.review_id)}">Open review</a></td></tr>`).join('');
    return `<div class="vi-wrap vi-review"><header class="vi-page-h"><p class="vi-kicker">Operator review</p><h1>Operator reports</h1><p class="vi-lede">Category-3 reviews make one report row each. They stay here until an operator decides the review.</p></header><div class="table-wrap"><table class="vi-table"><thead><tr><th scope="col">Report</th><th scope="col">Object</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col"></th></tr></thead><tbody>${rows || '<tr><td colspan="5">No reports.</td></tr>'}</tbody></table></div></div>`;
}

module.exports = { queue, item, reports, PLAIN, SHORT, ACTION, evidenceFigure };
