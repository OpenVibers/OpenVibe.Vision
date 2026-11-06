'use strict';

/**
 * The unsafe-image review (VIS-6's last item, decided 2026-11-06).
 *
 * An image review sorts into exactly three categories, in the owner's words:
 *
 *   fine          Fine — OK to show, including nudity.
 *   sex_acts      Sex acts or porn — never public. The object is hidden from every public surface and kept for
 *                 its owner; an adults-only section can show it later.
 *   minor_sexual  Sexual content involving a minor — always blocked. The object is quarantined and a report
 *                 record is made for the operator. Nothing is sent to an external authority automatically:
 *                 that needs the NCMEC registration the owner holds.
 *
 * The text classifier is the same rule Live's auto-clip filter uses (nudity is allowed; sex acts are not; a
 * child plus nudity or sex acts is the hard line). The image classifier asks OpenVibe.AI one strict question
 * and reads a JSON answer; an AI answer is never the sole judge of a child-safety report, so the operator
 * sees every category-3 row and can decide it in the review UI. Child-safety hash matching is a separate
 * service (Cloudflare's CSAM Scanning Tool, NCMEC lists), not this language model.
 *
 * No image bytes are stored. A review stores the caller's object reference, a sha256, the category and the
 * model provenance; a preview URL is kept only so the operator's page can show the picture.
 */
const { VisionError } = require('./service');
const { forModel } = require('./images');

const CATEGORIES = Object.freeze(['fine', 'sex_acts', 'minor_sexual']);

const PLAIN = Object.freeze({
    fine: 'Fine — OK to show, including nudity',
    sex_acts: 'Sex acts or porn — never public; kept for its owner',
    minor_sexual: 'Sexual content involving a minor — always blocked and reported to the operator',
});

const ACTION = Object.freeze({
    fine: 'allow',
    sex_acts: 'hide',
    minor_sexual: 'quarantine_and_report',
});

const MINOR = /\b(?:child(?:ren)?|kids?|minors?|underage|preteens?|toddlers?|bab(?:y|ies)|infants?|boys?|girls?|teen(?:age(?:rs?)?|s)?|schoolboys?|schoolgirls?)\b/i;
const NUDE = /\b(?:naked|nude|nudity|undress(?:ed|ing)?|topless|bottomless|genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|breasts?|nipples?)\b/i;
// What a scene shows, not what someone talks about in passing: sex acts and pornography. Nudity and body
// words are deliberately absent (a nude body is not a sex act).
const SEX = /\b(?:sexual(?:ly)?\s+(?:acts?|activity|intercourse|content|explicit|material|scenes?)|sex\s+(?:acts?|scenes?|shows?|clubs?|work|toys?)|having\s+sex|(?:pornographic|explicit\s+adult|adult)\s+(?:content|material|footage|scenes?|imagery|videos?|films?|acts?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|oral\s+sex|anal\s+sex|penetrat\w*|erotic\w*|orgasm\w*|blow\s?job|hand\s?job|nsfw)\b/i;

/** The most severe of categories, so a text hint can never make an image look safer than the image pass says. */
function worst(...categories) {
    const rank = { fine: 0, sex_acts: 1, minor_sexual: 2 };
    return categories.filter((c) => CATEGORIES.includes(c)).sort((a, b) => rank[b] - rank[a])[0] || 'fine';
}

/** Sort a piece of text (an AI overview, a caption, a report) into the three categories. */
function classifyText(...texts) {
    const all = texts.filter((t) => t != null).map(String).join('\n').trim();
    if (!all) return { category: 'fine', cue: 'empty', reason: 'there is no text to judge' };
    const minor = MINOR.test(all);
    const nude = NUDE.test(all);
    const sex = SEX.test(all);
    if (minor && (sex || nude)) {
        return { category: 'minor_sexual', cue: 'minor+nudity_or_sex', reason: 'the text puts a child together with nudity or sex acts' };
    }
    if (sex) return { category: 'sex_acts', cue: 'sex_acts', reason: 'the text describes sex acts or pornography' };
    if (nude) return { category: 'fine', cue: 'nudity', reason: 'the text describes nudity, which is allowed; it does not describe a sex act' };
    return { category: 'fine', cue: 'none', reason: 'the text describes neither sex acts nor a child with nudity' };
}

const CLASSIFY_PROMPT = [
    'Classify this image for a content reviewer. Return ONLY a JSON object, with no prose and no code fence:',
    '{"sexual": true or false, "nudity": true or false, "minor": true or false, "sex_acts": true or false, "reason": "one short sentence"}',
    'sexual is true when the image shows a sex act or pornography. Nudity alone is allowed and is not sexual.',
    'minor is true when anyone in the image appears to be a child or teenager. Do not guess age from an adult',
    'who merely looks young; say true only when the picture shows a minor. sex_acts is true only when the image',
    'shows a sex act (not kissing, not nudity). If a minor is present and the image shows nudity or a sex act, set',
    'sexual true as well: a minor in a sexual image is always the hard line. Never identify or name anyone.',
].join(' ');

function parseClassification(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const at = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (at < 0 || end <= at) return null;
    let body;
    try { body = JSON.parse(raw.slice(at, end + 1)); } catch { return null; }
    if (!body || typeof body !== 'object') return null;
    const flag = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(String(v));
    const sexual = flag(body.sexual) || flag(body.sex_acts) || flag(body.sexActs);
    const nudity = flag(body.nudity) || flag(body.nude);
    const minor = flag(body.minor);
    const category = minor && (sexual || nudity) ? 'minor_sexual' : sexual ? 'sex_acts' : 'fine';
    return {
        category,
        sexual,
        minor,
        reason: String(body.reason || '').replace(/\s+/g, ' ').slice(0, 300) || null,
    };
}

function wireReview(row) {
    if (!row) return null;
    const report = row.report && typeof row.report === 'object' ? row.report : null;
    return {
        id: row.id,
        category: row.category,
        plain_words: row.plain_words || PLAIN[row.category],
        action: row.action,
        public: Boolean(row.is_public),
        status: row.status,
        object_type: row.object_type,
        object_id: row.object_id == null ? null : String(row.object_id),
        owner_subject: row.owner_subject == null ? null : row.owner_subject,
        subject: row.subject == null ? null : row.subject,
        reason: row.reason == null ? null : row.reason,
        cue: row.cue == null ? null : row.cue,
        engine: row.engine,
        model: row.model == null ? null : row.model,
        provider: row.provider == null ? null : row.provider,
        route: row.route == null ? null : row.route,
        confidence: row.confidence == null ? null : Number(row.confidence),
        cost_usd: Number(row.cost_usd) || 0,
        latency_ms: Number(row.latency_ms) || 0,
        preview_url: row.preview_url == null ? null : row.preview_url,
        image_sha256: row.image_sha256 == null ? null : row.image_sha256,
        reviewed_by: row.reviewed_by == null ? null : row.reviewed_by,
        reviewed_at: row.reviewed_at == null ? null : (row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : String(row.reviewed_at)),
        created_at: row.created_at == null ? null : (row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)),
        report: report ? wireReport(report) : null,
    };
}

function wireReport(row) {
    if (!row) return null;
    return {
        id: row.id,
        review_id: row.review_id,
        category: row.category,
        object_type: row.object_type,
        object_id: row.object_id == null ? null : String(row.object_id),
        owner_subject: row.owner_subject == null ? null : row.owner_subject,
        reason: row.reason == null ? null : row.reason,
        status: row.status,
        created_at: row.created_at == null ? null : (row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)),
        resolved_at: row.resolved_at == null ? null : (row.resolved_at instanceof Date ? row.resolved_at.toISOString() : String(row.resolved_at)),
    };
}

function createReview({ config, s, ai, store, log = console }) {
    /**
     * classify({ image, text }) → { category, plain_words, action, reason, cue, engine, model, ... }.
     * Text alone is enough (Live's AI overviews); an image asks OpenVibe.AI for the strict JSON above.
     */
    async function classify({ image = null, text = null } = {}) {
        const byText = text && String(text).trim() ? { ...classifyText(text), engine: 'text', model: null, provider: null, route: 'text.rule', costUsd: 0, ms: 0 } : null;
        if (!image) {
            if (!byText) throw new VisionError(400, 'vision.review_invalid', 'send an image or text to review');
            return { ...byText, plain: PLAIN[byText.category], action: ACTION[byText.category], public: byText.category === 'fine', confidence: null };
        }
        if (!ai.enabled) {
            if (byText) return { ...byText, plain: PLAIN[byText.category], action: ACTION[byText.category], public: byText.category === 'fine', confidence: null };
            throw new VisionError(503, 'vision.review_unavailable', 'OpenVibe.AI is not configured on this host; the review cannot judge an image without text');
        }
        const normal = await forModel(image.buffer);
        const started = Date.now();
        let a;
        try {
            a = await ai.answer({ dataUrl: normal.dataUrl, task: 'ask', question: CLASSIFY_PROMPT, maxTokens: 300, temperature: 0 });
        } catch (err) {
            if (byText) {
                return { ...byText, plain: PLAIN[byText.category], action: ACTION[byText.category], public: byText.category === 'fine', confidence: null, reason: `${byText.reason} (the image pass was unavailable)` };
            }
            throw new VisionError(502, 'vision.review_unavailable', (err && (err.detail || err.message)) || 'OpenVibe.AI did not answer the review');
        }
        const parsed = parseClassification(a.text);
        if (!parsed) {
            if (byText) {
                return { ...byText, plain: PLAIN[byText.category], action: ACTION[byText.category], public: byText.category === 'fine', confidence: null, reason: `${byText.reason} (the image pass returned no usable classification)` };
            }
            throw new VisionError(502, 'vision.review_invalid_answer', 'OpenVibe.AI answered the review without a usable classification');
        }
        const category = worst(parsed.category, byText ? byText.category : 'fine');
        return {
            category,
            plain: PLAIN[category],
            action: ACTION[category],
            public: category === 'fine',
            reason: parsed.reason || (byText && byText.reason) || null,
            cue: parsed.category === category ? (parsed.minor ? 'image:minor' : parsed.sexual ? 'image:sex_acts' : parsed.nudity ? 'image:nudity' : 'image:fine') : (byText && byText.cue) || 'image',
            engine: byText ? 'text+ai' : 'ai',
            model: a.model,
            provider: a.provider,
            route: a.route,
            confidence: null,
            costUsd: a.costUsd,
            ms: Date.now() - started,
            image,
        };
    }

    /** Classify and store one review; a category-3 row always creates the operator's report record. */
    async function review({ requester, subject = null, image = null, text = null, objectType = 'unknown', objectId = null, ownerSubject = null, previewUrl = null, note = null }) {
        const got = await classify({ image, text });
        // A person's own review without an object owner belongs to them; a service names the owner explicitly.
        const owner = ownerSubject || subject || null;
        const saved = await store.saveReview({
            subject, requester, objectType, objectId, ownerSubject: owner,
            imageSha256: image ? image.sha256 : null, imageMime: image ? image.mime : null, imageBytes: image ? image.bytes : null,
            previewUrl, category: got.category, plainWords: PLAIN[got.category], action: ACTION[got.category],
            public: got.category === 'fine', reason: note ? `${got.reason || ''}${got.reason ? ' — ' : ''}${String(note).slice(0, 300)}` : got.reason,
            cue: got.cue, engine: got.engine, model: got.model, provider: got.provider, route: got.route,
            confidence: got.confidence, costUsd: got.costUsd || 0, latencyMs: got.ms || 0,
        });
        if (got.category === 'minor_sexual') {
            const report = await store.createOperatorReport({
                reviewId: saved.id, category: got.category, objectType, objectId, ownerSubject: owner,
                reason: got.reason || 'sexual content involving a minor',
            });
            if (!report) log.error(`[Vision] review ${saved.id}: category minor_sexual but no operator report was recorded`);
            return store.reviewWithReport(saved.id);
        }
        return saved;
    }

    /** An operator's explicit decision: exactly one of the three categories, never a new one. */
    async function decide(id, category, by) {
        if (!CATEGORIES.includes(category)) throw new VisionError(400, 'vision.review_invalid_category', `category must be one of ${CATEGORIES.join(', ')}`);
        const got = await store.reviewById(id);
        if (!got) throw new VisionError(404, 'vision.review_not_found', 'No such review.');
        await store.decideReview(id, {
            category, plainWords: PLAIN[category], action: ACTION[category], public: category === 'fine', reviewedBy: by,
        });
        if (category === 'minor_sexual') {
            const existing = await store.operatorReportFor(id);
            if (!existing) await store.createOperatorReport({
                reviewId: id, category, objectType: got.object_type, objectId: got.object_id,
                ownerSubject: got.owner_subject, reason: got.reason || 'operator marked sexual content involving a minor',
            });
        } else {
            await store.dismissOperatorReport(id, by);
        }
        return store.reviewWithReport(id);
    }

    return { classify, review, decide };
}

module.exports = {
    CATEGORIES, PLAIN, ACTION, MINOR, NUDE, SEX,
    classifyText, parseClassification, worst, wireReview, wireReport, createReview,
};
