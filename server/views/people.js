'use strict';
const { esc } = require('../render/html');

const LABELS = { verify: 'Verify yourself', find: 'Find yourself', cast: 'Cast tagging', library: "Your library's people" };
function people({ signedIn, consents = [], texts, regions = [] }) {
    const active = (f) => consents.find((c) => c.feature === f && !c.revoked_at);
    return `<div class="vi-wrap vi-page-pad vi-narrow" id="vi-people"><header class="vi-page-h"><p class="vi-kicker">Your choice</p><h1>People in Vision</h1><p class="vi-lede">Each purpose has its own consent. Face matching runs locally. Turning a feature off erases its template at once.</p></header>
${signedIn ? '' : '<p class="vi-note">Sign in with your Network account to manage face features.</p>'}
${Object.entries(texts).map(([feature, item]) => {
    const on = active(feature), scope = on?.scope || '', needed = on ? '' : ' required';
    return `<section class="vi-card vi-person-feature" id="vi-${feature}"><h2>${esc(LABELS[feature])}</h2><p>${esc(item.text)}</p>
<form class="vi-form" method="post" action="/people/consent/${feature}">
<input type="hidden" name="text_version" value="${esc(item.version)}">
    ${feature === 'cast' ? `<label class="vi-field"><span>Named channel ID</span><input name="channel"${needed} value="${esc(scope)}" placeholder="live:your-channel"></label><label class="vi-check"><input type="checkbox" name="adult" value="true"${needed}> I confirm I am an adult co-streamer</label>` : ''}
    ${feature === 'library' ? `<label class="vi-field"><span>Region</span><input name="region"${needed} placeholder="US-IL" value="${esc(regions[0] || '')}"></label><p class="vi-fine">Available regions: ${esc(regions.join(', ') || 'none configured')}</p>` : ''}
    <label class="vi-field"><span>Signature (your typed name)</span><input name="signed_name" autocomplete="name"${needed} maxlength="160"></label>
<label class="vi-check"><input type="checkbox" role="switch" name="enabled" value="yes" ${on ? 'checked' : ''}${signedIn ? '' : ' disabled'}> ${on ? 'On' : 'Off'}</label>
<button class="vi-btn" type="submit"${signedIn ? '' : ' disabled'}>Save this choice</button></form>
${on && feature !== 'library' ? `<form method="post" action="/people/enrol/${feature}" enctype="multipart/form-data" class="vi-form"><input type="hidden" name="channel" value="${esc(scope)}"><label class="vi-field"><span>One face image for enrolment</span><input type="file" name="image" accept="image/*" required></label><button class="vi-btn vi-btn-quiet" type="submit">Enrol my face</button></form>` : ''}
${on ? `<p class="vi-fine">Granted ${esc(String(on.granted_at))}${scope ? ` for ${esc(scope)}` : ''} · consent ${esc(on.text_version)}</p>` : ''}</section>`;
}).join('')}
<p class="vi-fine">A face match cannot unlock an account by itself. Liveness is not checked yet; use another factor and a non-biometric route. <a href="/people/privacy">Read the retention and privacy rules.</a></p></div>`;
}
function privacy() {
    return `<div class="vi-wrap vi-page-pad vi-narrow" id="vi-privacy"><header class="vi-page-h"><p class="vi-kicker">Privacy</p><h1>Faces stay in your chosen purpose</h1></header>
<section class="vi-card"><h2>What happens</h2><p>Detect, count and blur use local YuNet without identity templates or tracking. Verification compares only your enrolled template with your own attempt. Find yourself searches only your own Vision uploads. Cast tagging checks a named channel roster of consenting adults. Library groups are private, region gated, and unknown faces remain unlabelled.</p></section>
<section class="vi-card"><h2>Retention and control</h2><p>Templates and derived tags are erased when you switch a purpose off. A daily job removes active templates at the latest three years after your last use. Revoked consent audit records are removed within one year after the purpose ends. Account export and deletion include face templates, consents, uploads, groups and tags.</p></section>
<section class="vi-card"><h2>What never happens</h2><p>No face or template is sent to a cloud model, public Search, model prompts or Bench. No stranger identification against the open web. No public face index. AI text never describes a person's looks. A face match alone never unlocks anything: liveness is not checked and a second factor and non-biometric route are required for consequential use.</p></section>
<p><a href="/privacy">The full OpenVibe.Vision privacy policy</a> · <a href="/people">Manage your choices</a></p></div>`;
}
module.exports = { people, privacy };
