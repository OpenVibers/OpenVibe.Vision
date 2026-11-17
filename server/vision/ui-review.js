'use strict';

/**
 * The UI review panel (plan §AD.25; the owner, 2026-11-17: "Interconnect openvibe.vision with openvibe.design and codes
 * and actor so that it can analyze interfaces and designs and improve and critique multi model multi harness
 * configurable modular powerful system"). One screenshot, three passes in one call (service.js reviewUi):
 *
 *   1. the gate: the UI check's screenshot pass (local, free): cut-off text and low contrast from the pixels;
 *   2. the panel: up to three vision models (the caller's hints, or AI's own pick), in parallel, each alone with the
 *      picture, OpenVibe's design rules (openvibe.design/api/v1/rules) and the review checklist, answering in JSON. No
 *      critic sees another's answer: each judges with a fresh eye;
 *   3. the merge: the same finding from several critics is one row that says how many saw it, ranked by severity, then
 *      by agreement. What each model found, its cost and its time stay beside it.
 *
 *   rulesFrom(doc)                           → [{ id, rule }] of the design areas, from Design's rules answer
 *   promptFor({ rules, checks, focus, viewport, theme }) → the words each critic is given
 *   parseFindings(text)                      → { ok, works: [string], findings: [{ severity, where, rule, says, fix }] }
 *   merge(panel)                             → [{ severity, rule, where, says, fix, seen_by: [model], agreement }]
 */

// The rule areas a reviewer of a screen uses (Design's register; building and products are not about a screen).
const DESIGN_AREAS = ['honest', 'length', 'motion', 'navigation', 'phone', 'words', 'look'];
const SEVERITY = { high: 3, medium: 2, low: 1 };
const MAX_RULES = 90;
const MAX_FINDINGS = 12;

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function rulesFrom(doc) {
    const all = doc && Array.isArray(doc.rules) ? doc.rules : Array.isArray(doc) ? doc : [];
    return all
        .map((r) => (typeof r === 'string' ? { id: null, rule: clip(r, 200) } : r && { id: r.id ? clip(r.id, 60) : null, rule: clip(r.rule, 200), area: r.area || null }))
        .filter((r) => r && r.rule && (!r.area || DESIGN_AREAS.includes(r.area)))
        .slice(0, 300);
}

function promptFor({ rules = [], checks = [], focus = '', viewport = null, theme = null } = {}) {
    const vp = viewport && viewport.w ? `${viewport.w}×${viewport.h || '?'} px` : 'unknown size';
    const lines = [
        `You are reviewing a screenshot of an interface (a ${vp} view${theme ? `, ${theme} theme` : ''}). Judge only what you can see in the picture.`,
        'Hold it to the checklist: nothing sticks out sideways or is cut off; touch targets at least 44 px; text at least 12 px; no native select, checkbox, radio or file controls; no "Load more" button; icons fill their place and sit centred; loading shows the OpenVibe mark, never a spinner; empty and error states say what to do next; text readable against its background in this theme; one primary action per view; plain words, no internal names.',
    ];
    const rs = rulesFrom(rules).slice(0, MAX_RULES);
    if (rs.length) lines.push('', 'OpenVibe\'s design rules (id: rule):', ...rs.map((r) => `- ${r.id ? `${r.id}: ` : ''}${r.rule}`));
    const cs = (Array.isArray(checks) ? checks : []).slice(0, 15);
    if (cs.length) lines.push('', 'A machine check of the pixels found these; confirm or dismiss each from the picture:', ...cs.map((c) => `- ${clip(c.kind, 40)}: ${clip(c.detail, 160)}`));
    if (focus) lines.push('', `The person asked you to look especially at: ${clip(focus, 400)}`);
    lines.push('', `Answer with JSON only, no prose around it: {"works": ["what works, briefly"], "findings": [{"severity": "high|medium|low", "where": "the element and its place on the screen", "rule": "a rule id from the list, or checklist", "says": "what is wrong, in one sentence", "fix": "the fix, in one line"}]}. At most ${MAX_FINDINGS} findings, the one that spoils the screen most first. Never describe a person's looks.`);
    return lines.join('\n');
}

function parseFindings(text) {
    const raw = String(text || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return { ok: false, works: [], findings: [] };
    let doc;
    try { doc = JSON.parse(raw.slice(start, end + 1)); } catch { return { ok: false, works: [], findings: [] }; }
    const works = (Array.isArray(doc.works) ? doc.works : []).map((w) => clip(w, 200)).filter(Boolean).slice(0, 6);
    const findings = (Array.isArray(doc.findings) ? doc.findings : []).filter((f) => f && typeof f === 'object' && f.says)
        .map((f) => ({
            severity: SEVERITY[String(f.severity || '').toLowerCase()] ? String(f.severity).toLowerCase() : 'medium',
            where: clip(f.where, 160), rule: /^[a-z0-9-]{2,60}$/.test(String(f.rule || '')) ? String(f.rule) : 'checklist',
            says: clip(f.says, 300), fix: clip(f.fix, 240),
        })).slice(0, MAX_FINDINGS);
    return { ok: true, works, findings };
}

const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
function alike(a, b) {
    if (a.rule !== b.rule && a.rule !== 'checklist' && b.rule !== 'checklist') return false;
    const x = words(`${a.where} ${a.says}`), y = words(`${b.where} ${b.says}`);
    if (!x.size || !y.size) return false;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared += 1;
    return shared / Math.min(x.size, y.size) >= (a.rule === b.rule && a.rule !== 'checklist' ? 0.3 : 0.5);
}

function merge(panel) {
    const groups = [];
    for (const critic of Array.isArray(panel) ? panel : []) {
        const who = critic.model || critic.requested_model || 'a model';
        for (const f of Array.isArray(critic.findings) ? critic.findings : []) {
            const g = groups.find((x) => !x.seen_by.includes(who) && alike(x, f));
            if (g) {
                g.seen_by.push(who);
                if (SEVERITY[f.severity] > SEVERITY[g.severity]) Object.assign(g, { severity: f.severity, says: f.says, fix: f.fix || g.fix, where: f.where || g.where });
                if (g.rule === 'checklist' && f.rule !== 'checklist') g.rule = f.rule;
            } else groups.push({ ...f, seen_by: [who] });
        }
    }
    return groups.map((g) => ({ ...g, agreement: g.seen_by.length }))
        .sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || b.agreement - a.agreement);
}

module.exports = { rulesFrom, promptFor, parseFindings, merge, DESIGN_AREAS };
