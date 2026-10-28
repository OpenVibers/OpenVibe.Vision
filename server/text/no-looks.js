'use strict';

/**
 * No looks in public AI text (the network rule, openvibe-sdk/no-looks, shared with Live, Community and MediaHub):
 * an AI-written summary never describes a person's body, clothing, hair, face or guessed gender. A summary that
 * names looks at all is not repaired word by word — it is replaced by the entry's title, as Meme's plan says.
 * Verbatim quotes are never passed through this: rewriting a quote would falsify the citation.
 */
const { noLooks, hasLooks } = require('openvibe-sdk/no-looks');

/** The summary to store for an AI-written entry summary. */
function cleanSummary(title, summary) {
    const t = String(title || '').trim() || 'Untitled item';
    const s = String(summary == null ? '' : summary).trim();
    if (!s) return t;
    if (hasLooks(s)) return t;
    const cleaned = String(noLooks(s) || '').trim();
    return cleaned || t;
}

module.exports = { cleanSummary, noLooks, hasLooks };

/**
 * Public AI text in Vision: an answer that names a person's looks at all is replaced by a neutral sentence,
 * never repaired word by word. The prompt already forbids it; this is the guarantee after the model speaks.
 */
const SAFE_ANSWER = 'I can describe the picture without describing anyone\'s appearance. Ask about the scene, the text, the objects or what is happening.';

function cleanAnswer(text, { fallback = SAFE_ANSWER } = {}) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return fallback;
    // Live's rule: a sentence about someone's looks goes whole (noLooks can leave "has long blonde hair" behind
    // once it has neutralised the pronoun); the rest still passes noLooks. If nothing look-free remains, the
    // neutral sentence is the answer.
    const kept = s.split(/(?<=[.!?])\s+/).filter((sentence) => !hasLooks(sentence)).join(' ').trim();
    if (!kept) return fallback;
    const cleaned = String(noLooks(kept) || '').trim();
    return cleaned && !hasLooks(cleaned) ? cleaned : fallback;
}

module.exports = { cleanSummary, cleanAnswer, noLooks, hasLooks, SAFE_ANSWER };
