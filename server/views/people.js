'use strict';
const { esc } = require('../render/html');

const LABELS = {
    verify: 'Verify yourself',
    find: 'Find yourself',
    cast: 'Cast tagging',
    library: "Your library's people",
};
const PLAIN = {
    verify: 'Compare your own face with your own verification attempt. Nothing else is unlocked.',
    find: 'Search your own pictures for your face. The results are private links.',
    cast: 'Match only inside a channel whose adult co-streamers opted in.',
    library: 'Group the faces in your own library. Unknown faces stay unlabelled.',
};

/**
 * Four face purposes, each with its own signed consent. A person can read every purpose before signing in; the
 * form and its signature fields sit one tap down in <details>, so the page is a short list of choices instead of a
 * wall of forms. The ids (vi-verify …) and the form actions are part of the page contract.
 */
function people({ signedIn, consents = [], texts, regions = [] }) {
    const active = (f) => consents.find((c) => c.feature === f && !c.revoked_at);
    return `<div class="vi-wrap vi-page-pad vi-narrow" id="vi-people">
<header class="vi-page-h"><p class="vi-kicker">Your choice</p><h1>Your face choices</h1><p class="vi-lede">Four purposes, four separate switches. Matching runs on this host, each purpose is off until you sign it, and turning one off erases its template at once.</p></header>
${signedIn ? '' : `<div class="vi-signin" id="vi-people-signin"><p>Sign in with your Network account to see or change your choices. You can read all four below first.</p><a class="vi-btn" href="/auth/login?next=%2Fpeople">Sign in with OpenVibe</a></div>`}
<ul class="vi-purposes">
${Object.entries(texts).map(([feature, item]) => {
        const on = active(feature), scope = on?.scope || '', needed = on ? '' : ' required';
        const enrol = on && feature !== 'library';
        const action = on ? 'Manage or turn off' : 'Read and turn on';
        return `<li class="vi-purpose" id="vi-${feature}">
<div class="vi-purpose-head"><div><h2>${esc(LABELS[feature])}</h2><p>${esc(PLAIN[feature] || item.text)}</p>${on ? `<p class="vi-fine">On${scope ? ` for ${esc(scope)}` : ''} · signed ${esc(on.text_version)}</p>` : ''}</div><span class="vi-status${on ? ' is-on' : ''}">${on ? 'On' : 'Off'}</span></div>
${signedIn ? `<details class="vi-disclose"><summary>${action}</summary>
<form class="vi-form" method="post" action="/people/consent/${feature}">
<input type="hidden" name="text_version" value="${esc(item.version)}">
<p class="vi-fine">${esc(item.text)}</p>
${feature === 'cast' ? `<label class="vi-field"><span>Named channel ID</span><input name="channel"${needed} value="${esc(scope)}" placeholder="live:your-channel"></label><label class="vi-check"><input type="checkbox" name="adult" value="true"${needed}> <span>I confirm I am an adult co-streamer</span></label>` : ''}
${feature === 'library' ? `<label class="vi-field"><span>Region</span><input name="region"${needed} placeholder="US-IL" value="${esc(regions[0] || '')}"></label><p class="vi-fine">Available regions: ${esc(regions.join(', ') || 'none configured')}</p>` : ''}
<label class="vi-field"><span>Signature (your typed name)</span><input name="signed_name" autocomplete="name"${needed} maxlength="160"></label>
<label class="vi-check"><input type="checkbox" role="switch" name="enabled" value="yes" ${on ? 'checked' : ''}> <span>${on ? 'On' : 'Off'}</span></label>
<div class="vi-actions"><button class="vi-btn" type="submit">Save this choice</button></div>
</form>
${enrol ? `<form method="post" action="/people/enrol/${feature}" enctype="multipart/form-data" class="vi-form vi-enrol">
<input type="hidden" name="channel" value="${esc(scope)}">
<label class="vi-field"><span>One face image for enrolment</span><input type="file" name="image" accept="image/*" required></label>
<div class="vi-actions"><button class="vi-btn vi-btn-quiet" type="submit">Enrol my face</button></div>
</form>` : ''}
</details>` : ''}
</li>`;
    }).join('')}
</ul>
<section class="vi-people-note"><h2>What never happens</h2><p>No stranger identification. No public face index. No face or template sent to a cloud model, Search, model prompts or Bench. A match alone never unlocks anything: liveness is not checked yet, so use another factor and a non-biometric route.</p><p><a href="/people/privacy">Read the retention and privacy rules</a></p></section>
</div>`;
}

function privacy() {
    return `<div class="vi-wrap vi-page-pad vi-narrow" id="vi-privacy"><header class="vi-page-h"><p class="vi-kicker">Privacy</p><h1>Faces stay in your chosen purpose</h1></header>
<section class="vi-card"><h2>What happens</h2><p>Detect, count and blur use local YuNet without identity templates or tracking. Verification compares only your enrolled template with your own attempt. Find yourself searches only your own Vision uploads. Cast tagging checks a named channel roster of consenting adults. Library groups are private, region gated, and unknown faces remain unlabelled.</p></section>
<section class="vi-card"><h2>Retention and control</h2><p>Templates and derived tags are erased when you switch a purpose off. A daily job removes active templates at the latest three years after your last use. Revoked consent audit records are removed within one year after the purpose ends. Account export and deletion include face templates, consents, uploads, groups and tags.</p></section>
<section class="vi-card"><h2>What never happens</h2><p>No face or template is sent to a cloud model, public Search, model prompts or Bench. No stranger identification against the open web. No public face index. AI text never describes a person's looks. A face match alone never unlocks anything: liveness is not checked and a second factor and non-biometric route are required for consequential use.</p></section>
<p><a href="/privacy">The full OpenVibe.Vision privacy policy</a> · <a href="/people">Manage your choices</a></p></div>`;
}
module.exports = { people, privacy };
