'use strict';

/**
 * The UI check (plan §5.8 and §3.11): overflow, cut-off text, low contrast, overlap and layering faults.
 *
 * Two local passes, no browser, no model, no paid service:
 *
 *   static-html  parses the document and its inline CSS, estimates the boxes and computes WCAG contrast from the
 *                colours. It is the pass a generated HTML page or a URL gets. JavaScript is not executed, and a
 *                remote stylesheet is not fetched: those are stated as limits in `warnings`.
 *   screenshot   reads a PNG/JPEG screenshot with the local OCR boxes and sharp's pixels: text at an edge is
 *                reported as cut off, and the contrast inside each word box is measured. Layering cannot be seen
 *                from pixels, and the answer says so.
 *
 * Findings are data: { kind, severity, selector, detail, evidence }. The API is what Design's Arena calls.
 */
const sharp = require('sharp');
const { assertPublicUrl } = require('./images');

const BLOCK = new Set(['html', 'body', 'div', 'p', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'form', 'fieldset', 'legend', 'blockquote', 'pre', 'hr', 'address', 'details', 'summary', 'dialog', 'canvas', 'video', 'img']);
const INLINE = new Set(['span', 'a', 'b', 'strong', 'i', 'em', 'u', 'small', 'code', 'kbd', 'samp', 'var', 'sub', 'sup', 'label', 'button', 'input', 'select', 'textarea', 'br', 'time', 'abbr', 'cite', 'q', 'mark', 'svg', 'path']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HIDDEN_TAGS = new Set(['script', 'style', 'template', 'head', 'title', 'meta', 'link', 'base', 'noscript']);
const NAMED = {
    transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1], red: [255, 0, 0, 1],
    green: [0, 128, 0, 1], blue: [0, 0, 255, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1],
    silver: [192, 192, 192, 1], maroon: [128, 0, 0, 1], olive: [128, 128, 0, 1], lime: [0, 255, 0, 1],
    aqua: [0, 255, 255, 1], teal: [0, 128, 128, 1], navy: [0, 0, 128, 1], fuchsia: [255, 0, 255, 1],
    purple: [128, 0, 128, 1], orange: [255, 165, 0, 1], yellow: [255, 255, 0, 1], pink: [255, 192, 203, 1],
    brown: [165, 42, 42, 1], cyan: [0, 255, 255, 1], magenta: [255, 0, 255, 1], gold: [255, 215, 0, 1],
    darkgray: [169, 169, 169, 1], darkgrey: [169, 169, 169, 1], dimgray: [105, 105, 105, 1], dimgrey: [105, 105, 105, 1],
    lightgray: [211, 211, 211, 1], lightgrey: [211, 211, 211, 1], whitesmoke: [245, 245, 245, 1], gainsboro: [220, 220, 220, 1],
};
const MAX_NODES = 6000;

function decodeEntities(s) {
    return String(s == null ? '' : s)
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function parseAttrs(s) {
    const out = {};
    const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = re.exec(s || ''))) {
        const k = m[1].toLowerCase();
        out[k] = decodeEntities(m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : '')));
    }
    return out;
}

/** A forgiving HTML tree. Script/style/head content is not part of the visible tree; <style> text is collected. */
function parseHtml(html) {
    const root = { tag: '#document', attrs: {}, classes: [], children: [], text: '', parent: null };
    const stack = [root];
    const styles = [];
    const warnings = [];
    let nodes = 0;
    let i = 0;
    const s = String(html || '');
    const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi;
    let m;
    const addText = (text) => {
        if (!text) return;
        const top = stack[stack.length - 1];
        if (!top || HIDDEN_TAGS.has(top.tag)) return;
        const clean = decodeEntities(text);
        if (clean.trim()) top.text = `${top.text || ''}${top.text ? ' ' : ''}${clean.replace(/\s+/g, ' ').trim()}`;
    };
    while ((m = tagRe.exec(s))) {
        addText(s.slice(i, m.index));
        i = tagRe.lastIndex;
        if (m[0].startsWith('<!--') || /^<!/.test(m[0])) continue;
        if (m[1]) {
            const tag = m[1].toLowerCase();
            for (let j = stack.length - 1; j > 0; j--) {
                if (stack[j].tag === tag) { stack.length = j; break; }
            }
            continue;
        }
        if (!m[2]) continue;
        const tag = m[2].toLowerCase();
        const attrs = parseAttrs(m[3] || '');
        if (tag === 'style') {
            const end = s.toLowerCase().indexOf('</style', tagRe.lastIndex);
            if (end >= 0) {
                styles.push(s.slice(tagRe.lastIndex, end));
                tagRe.lastIndex = end;
                i = end;
            }
            continue;
        }
        if (nodes++ > MAX_NODES) { warnings.push('the document has more than 6000 elements; the pass stopped early'); break; }
        const node = {
            tag, attrs, id: attrs.id || null,
            classes: String(attrs.class || '').split(/\s+/).filter(Boolean),
            children: [], text: '', parent: stack[stack.length - 1],
        };
        node.parent.children.push(node);
        if (HIDDEN_TAGS.has(tag)) { stack.push(node); continue; }
        if (VOID.has(tag) || m[4] === '/') continue;
        stack.push(node);
    }
    addText(s.slice(i));
    // A fragment (or a document without body) still gets the body box, so `body { … }` rules apply.
    if (!root.children.some((c) => c.tag === 'body')) {
        const body = { tag: 'body', attrs: {}, id: null, classes: [], children: root.children, text: '', parent: root };
        for (const c of body.children) c.parent = body;
        root.children = [body];
    }
    if (!styles.length) warnings.push('no inline <style> block: only inline style attributes were read');
    warnings.push('JavaScript was not executed and remote stylesheets were not fetched; this is a static layout pass');
    return { root, styles, warnings };
}

function parseColor(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!v || v === 'currentcolor' || v === 'inherit' || v === 'initial' || v === 'unset') return null;
    if (NAMED[v]) return NAMED[v].slice();
    if (v === 'transparent') return [0, 0, 0, 0];
    let m = /^#([0-9a-f]{3,8})$/i.exec(v);
    if (m) {
        let h = m[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        if (h.length === 4) h = h.split('').map((c) => c + c).join('');
        if (h.length === 6 || h.length === 8) {
            return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
        }
    }
    m = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
    if (m) {
        const n = (x, max) => (String(x).endsWith('%') ? Math.round(parseFloat(x) * max / 100) : parseFloat(x));
        const a = m[4] == null ? 1 : (String(m[4]).endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        return [n(m[1], 255), n(m[2], 255), n(m[3], 255), Math.max(0, Math.min(1, Number.isFinite(a) ? a : 1))];
    }
    m = /^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
    if (m) {
        const h = ((parseFloat(m[1]) % 360) + 360) % 360 / 360;
        const sat = parseFloat(m[2]) / 100; const li = parseFloat(m[3]) / 100;
        const q = li < 0.5 ? li * (1 + sat) : li + sat - li * sat;
        const p = 2 * li - q;
        const hue = (t) => { let x = t; if (x < 0) x += 1; if (x > 1) x -= 1; if (x < 1 / 6) return p + (q - p) * 6 * x; if (x < 1 / 2) return q; if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6; return p; };
        const a = m[4] == null ? 1 : (String(m[4]).endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255), a];
    }
    return null;
}

const colorCss = (c) => (c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.round(c[3] * 100) / 100})` : 'unknown');
const luminance = (c) => {
    const f = (n) => { const x = n / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
function contrastRatio(fg, bg) {
    const a = fg[3] == null ? 1 : fg[3];
    const blended = [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a)));
    const l1 = luminance(blended); const l2 = luminance(bg);
    const hi = Math.max(l1, l2); const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
}

function parseLength(value, { fontSize = 16, parent = 16, root = 16, percentBase = 0 } = {}) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!v || v === 'auto' || v === 'none' || v === 'normal') return null;
    if (v.endsWith('px')) return parseFloat(v);
    if (v.endsWith('rem')) return parseFloat(v) * root;
    if (v.endsWith('em')) return parseFloat(v) * parent;
    if (v.endsWith('%')) return parseFloat(v) * percentBase / 100;
    if (v.endsWith('vw')) return parseFloat(v) * percentBase / 100;
    if (v.endsWith('vh')) return parseFloat(v) * percentBase / 100;
    if (v.endsWith('pt')) return parseFloat(v) * 4 / 3;
    if (/^[\d.]+$/.test(v)) return parseFloat(v);
    return null;
}

function parseDeclarations(text) {
    const out = {};
    for (const raw of String(text || '').split(';')) {
        const i = raw.indexOf(':');
        if (i < 0) continue;
        const k = raw.slice(0, i).trim().toLowerCase();
        const v = raw.slice(i + 1).trim();
        if (k && v) out[k] = v.replace(/\s*!important\s*$/i, '');
    }
    if (out.background && !out['background-color']) {
        const simple = String(out.background).trim();
        if (parseColor(simple)) out['background-color'] = simple;
        else if (/^#|^rgb|^hsl/i.test(simple) && !/gradient|url\(/i.test(simple)) out['background-color'] = simple.split(/\s+/)[0];
        out['background-image'] = /gradient|url\(/i.test(simple) ? simple : out['background-image'];
    }
    if (out.margin) { const p = out.margin.split(/\s+/); out['margin-top'] = p[0]; out['margin-right'] = p[1] || p[0]; out['margin-bottom'] = p[2] || p[0]; out['margin-left'] = p[3] || p[1] || p[0]; }
    if (out.padding) { const p = out.padding.split(/\s+/); out['padding-top'] = p[0]; out['padding-right'] = p[1] || p[0]; out['padding-bottom'] = p[2] || p[0]; out['padding-left'] = p[3] || p[1] || p[0]; }
    if (out.inset) { const p = out.inset.split(/\s+/); out.top = p[0]; out.right = p[1] || p[0]; out.bottom = p[2] || p[0]; out.left = p[3] || p[1] || p[0]; }
    return out;
}

function mediaMatches(condition, viewport) {
    const c = String(condition || '').toLowerCase();
    if (!c || /\ball\b|\bscreen\b/.test(c)) {
        const max = /max-width\s*:\s*([\d.]+)px/.exec(c); const min = /min-width\s*:\s*([\d.]+)px/.exec(c);
        if (max && viewport.w > parseFloat(max[1])) return false;
        if (min && viewport.w < parseFloat(min[1])) return false;
        return true;
    }
    return false;
}

/** The inline stylesheets' rules, in source order. @media is applied only when the viewport matches. */
function parseRules(css, viewport) {
    const rules = [];
    const warnings = [];
    let order = 0;
    const text = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
    const parseBlock = (src) => {
        let i = 0;
        while (i < src.length) {
            const open = src.indexOf('{', i);
            if (open < 0) break;
            const selector = src.slice(i, open).trim();
            let depth = 1; let j = open + 1;
            while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
            const body = src.slice(open + 1, j - 1);
            if (/^@media\b/i.test(selector)) {
                const cond = selector.replace(/^@media\s*/i, '');
                if (mediaMatches(cond, viewport)) parseBlock(body);
            } else if (/^@supports\b/i.test(selector)) {
                parseBlock(body);
            } else if (selector.startsWith('@')) {
                // @font-face, @keyframes and @page carry no layout we can judge.
            } else {
                const declarations = parseDeclarations(body);
                order++;
                for (const one of selector.split(',')) {
                    const sel = one.trim();
                    if (!sel || /::|:(?:hover|focus|active|visited|before|after|placeholder|checked|disabled)/i.test(sel)) continue;
                    rules.push({ selector: sel, declarations, order, specificity: specificity(sel) });
                }
            }
            i = j;
        }
    };
    parseBlock(text);
    if (rules.length === 0) warnings.push('no usable CSS rules were found');
    return { rules, warnings };
}

function specificity(selector) {
    const s = String(selector).replace(/:root\b/g, 'html');
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
    const tags = (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    return ids * 10000 + cls * 100 + tags;
}

function matchCompound(node, compound) {
    if (!node || !node.tag || node.tag === '#document') return false;
    let c = String(compound).trim();
    if (!c) return false;
    if (c === '*') return true;
    c = c.replace(/:root\b/g, 'html').replace(/:(?:first|last|nth|only)-[a-z-]+(?:\([^)]*\))?/gi, '');
    const tag = /^([a-zA-Z][\w-]*)/.exec(c);
    if (tag && tag[1].toLowerCase() !== node.tag) return false;
    for (const m of c.matchAll(/#([\w-]+)/g)) if (node.id !== m[1]) return false;
    for (const m of c.matchAll(/\.([\w-]+)/g)) if (!node.classes.includes(m[1])) return false;
    for (const m of c.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/g)) {
        const v = node.attrs[m[1].toLowerCase()];
        if (v == null) return false;
        if (m[2] != null && String(v) !== m[2]) return false;
    }
    return true;
}

function matches(node, selector) {
    const tokens = String(selector).replace(/>/g, ' > ').trim().split(/\s+/);
    let i = tokens.length - 1;
    let n = node;
    while (i >= 0) {
        if (tokens[i] === '>') { i--; n = n && n.parent; if (!n) return false; continue; }
        if (!matchCompound(n, tokens[i])) return false;
        i--;
        if (i < 0) return true;
        if (tokens[i] === '>') { i--; n = n.parent; if (!n) return false; continue; }
        const next = tokens[i];
        let a = n.parent;
        while (a && !matchCompound(a, next)) a = a.parent;
        if (!a) return false;
        n = a; i--;
    }
    return true;
}

function initialDisplay(tag) { return BLOCK.has(tag) ? 'block' : (INLINE.has(tag) ? 'inline' : 'block'); }

function createComputed(root, rules, viewport) {
    const rootStyle = {
        color: [0, 0, 0, 1], 'background-color': 'transparent', 'background-image': null, 'font-size': 16, 'font-weight': 400,
        'line-height': 1.25, 'white-space': 'normal', 'text-align': 'left', display: 'block', position: 'static',
        overflow: 'visible', 'overflow-x': 'visible', 'overflow-y': 'visible', width: 'auto', height: 'auto',
        'max-width': 'none', 'min-width': '0', margin: [0, 0, 0, 0], padding: [0, 0, 0, 0],
        top: null, right: null, bottom: null, left: null, 'z-index': null, 'box-sizing': 'content-box',
        opacity: 1, 'text-transform': 'none', 'letter-spacing': 0, 'word-break': 'normal', 'border-left-width': 0, 'border-right-width': 0,
    };
    const inherited = ['color', 'font-size', 'font-weight', 'line-height', 'white-space', 'text-align', 'text-transform', 'letter-spacing', 'word-break', 'font-family'];
    const apply = (st, decls, parent) => {
        for (const [k, v] of Object.entries(decls)) {
            if (k === 'display') st.display = v;
            else if (k === 'position') st.position = v;
            else if (k === 'color') { const c = parseColor(v); if (c) st.color = c; }
            else if (k === 'background-color') { const c = parseColor(v); if (c) st['background-color'] = c; }
            else if (k === 'background-image') st['background-image'] = v;
            else if (k === 'font-size') { const n = parseLength(v, { parent: parent['font-size'], root: 16, percentBase: parent['font-size'] }); if (n != null) st['font-size'] = Math.max(0, n); }
            else if (k === 'font-weight') { st['font-weight'] = v === 'bold' ? 700 : v === 'normal' ? 400 : (parseInt(v, 10) || 400); }
            else if (k === 'line-height') { const n = parseLength(v, { parent: st['font-size'], percentBase: st['font-size'] }); st['line-height'] = n == null ? v : n; }
            else if (k === 'white-space') st['white-space'] = v;
            else if (k === 'text-align') st['text-align'] = v;
            else if (k === 'text-transform') st['text-transform'] = v;
            else if (k === 'letter-spacing') { const n = parseLength(v, { parent: st['font-size'], percentBase: st['font-size'] }); if (n != null) st['letter-spacing'] = n; }
            else if (k === 'word-break' || k === 'overflow-wrap') st['word-break'] = v;
            else if (k === 'width' || k === 'height' || k === 'max-width' || k === 'min-width') st[k] = v;
            else if (k === 'overflow') { st.overflow = v; st['overflow-x'] = v; st['overflow-y'] = v; }
            else if (k === 'overflow-x') { st.overflow = v; st['overflow-x'] = v; }
            else if (k === 'overflow-y') { st.overflow = v; st['overflow-y'] = v; }
            else if (/^margin-(top|right|bottom|left)$/.test(k)) { const idx = { 'margin-top': 0, 'margin-right': 1, 'margin-bottom': 2, 'margin-left': 3 }[k]; const n = parseLength(v, { parent: st['font-size'], percentBase: viewport.w }); st.margin[idx] = n == null ? 0 : n; }
            else if (/^padding-(top|right|bottom|left)$/.test(k)) { const idx = { 'padding-top': 0, 'padding-right': 1, 'padding-bottom': 2, 'padding-left': 3 }[k]; const n = parseLength(v, { parent: st['font-size'], percentBase: viewport.w }); st.padding[idx] = n == null ? 0 : n; }
            else if (['top', 'right', 'bottom', 'left'].includes(k)) st[k] = v;
            else if (k === 'z-index') st['z-index'] = v === 'auto' ? null : parseInt(v, 10);
            else if (k === 'box-sizing') st['box-sizing'] = v;
            else if (k === 'opacity') { const n = parseFloat(v); st.opacity = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1; }
            else if (k === 'border-left-width') st['border-left-width'] = parseLength(v) || 0;
            else if (k === 'border-right-width') st['border-right-width'] = parseLength(v) || 0;
            else if (k === 'hidden') st.display = 'none';
        }
    };
    const walk = (node, parent, depth) => {
        if (depth > 80) return;
        const st = {};
        for (const k of inherited) st[k] = parent ? parent[k] : rootStyle[k];
        for (const k of ['color', 'background-color', 'background-image', 'font-size', 'font-weight', 'line-height', 'white-space', 'text-align', 'display', 'position', 'overflow', 'overflow-x', 'overflow-y', 'width', 'height', 'max-width', 'min-width', 'top', 'right', 'bottom', 'left', 'z-index', 'box-sizing', 'opacity', 'text-transform', 'letter-spacing', 'word-break', 'border-left-width', 'border-right-width']) {
            st[k] = parent ? parent[k] : rootStyle[k];
        }
        st.margin = parent ? parent.margin.slice() : [0, 0, 0, 0];
        st.padding = parent ? parent.padding.slice() : [0, 0, 0, 0];
        st.color = parent ? parent.color : rootStyle.color;
        st['background-color'] = [0, 0, 0, 0];
        st['background-image'] = null;
        st.display = initialDisplay(node.tag);
        st.position = 'static'; st.overflow = 'visible'; st['overflow-x'] = 'visible'; st['overflow-y'] = 'visible';
        st.width = 'auto'; st.height = 'auto'; st['max-width'] = 'none'; st['min-width'] = '0';
        st.top = null; st.right = null; st.bottom = null; st.left = null; st['z-index'] = null;
        st['box-sizing'] = 'content-box'; st.opacity = parent ? parent.opacity : 1; st['border-left-width'] = 0; st['border-right-width'] = 0;
        st.margin = [0, 0, 0, 0]; st.padding = [0, 0, 0, 0];
        st['font-size'] = parent ? parent['font-size'] : 16;
        st['font-weight'] = parent ? parent['font-weight'] : 400;
        st['line-height'] = parent ? parent['line-height'] : 1.25;
        st['white-space'] = parent ? parent['white-space'] : 'normal';
        st['text-align'] = parent ? parent['text-align'] : 'left';
        st['text-transform'] = parent ? parent['text-transform'] : 'none';
        st['letter-spacing'] = parent ? parent['letter-spacing'] : 0;
        st['word-break'] = parent ? parent['word-break'] : 'normal';
        if (node.attrs && (node.attrs.hidden != null)) st.display = 'none';
        const applicable = rules.filter((r) => matches(node, r.selector)).sort((a, b) => a.specificity - b.specificity || a.order - b.order);
        for (const r of applicable) apply(st, r.declarations, parent || rootStyle);
        if (node.attrs && node.attrs.style) apply(st, parseDeclarations(node.attrs.style), parent || rootStyle);
        node.style = st;
        for (const child of node.children || []) walk(child, st, depth + 1);
    };
    walk(root, null, 0);
}

function selectorOf(node) {
    if (!node || !node.tag || node.tag === '#document') return ':root';
    const cls = (node.classes || []).slice(0, 2).map((c) => `.${c}`).join('');
    return `${node.tag}${node.id ? `#${node.id}` : ''}${cls}`;
}

function textWidth(text, st) {
    const fs = Number(st['font-size']) || 16;
    const bold = Number(st['font-weight']) >= 600;
    const spacing = Number(st['letter-spacing']) || 0;
    let n = 0;
    for (const ch of String(text || '')) {
        if (ch === ' ') n += 0.28;
        else if (/[ilI.,'`!|]/.test(ch)) n += 0.3;
        else if (/[mwMW@#%&]/.test(ch)) n += 0.86;
        else if (/[A-Z]/.test(ch)) n += 0.64;
        else n += 0.53;
    }
    return n * fs + Math.max(0, String(text || '').length - 1) * spacing;
}

function num(st, key) {
    const n = parseLength(st[key], { parent: st['font-size'], percentBase: st['font-size'] });
    return n == null ? 0 : n;
}

function boxOf(node, parentBox, viewport) {
    const st = node.style;
    if (!st || st.display === 'none' || st.opacity === 0) return null;
    const parentW = parentBox ? parentBox.contentW : viewport.w;
    const parentX = parentBox ? parentBox.x : 0;
    const parentY = parentBox ? parentBox.y : 0;
    const pad = st.padding || [0, 0, 0, 0];
    const mar = st.margin || [0, 0, 0, 0];
    const border = (Number(st['border-left-width']) || 0) + (Number(st['border-right-width']) || 0);
    const outerAvail = Math.max(0, parentW - mar[1] - mar[3]);
    const available = Math.max(0, outerAvail - pad[1] - pad[3] - border);
    let width;
    const wv = String(st.width || 'auto');
    if (wv === 'auto') width = (st.display === 'inline' || st.display === 'inline-block') ? Math.min(available, textWidth(node.text, st) + pad[1] + pad[3]) : available;
    else if (wv.endsWith('vw')) width = parseFloat(wv) * viewport.w / 100;
    else if (wv.endsWith('%')) width = outerAvail * parseFloat(wv) / 100;
    else width = parseLength(wv, { parent: st['font-size'], percentBase: outerAvail }) || available;
    const maxw = String(st['max-width'] || 'none');
    if (maxw !== 'none' && maxw !== 'auto') {
        const m = maxw.endsWith('%') ? outerAvail * parseFloat(maxw) / 100 : (maxw.endsWith('px') ? parseFloat(maxw) : null);
        if (m != null) width = Math.min(width, m);
    }
    const minw = String(st['min-width'] || '0');
    if (minw !== '0' && minw !== 'auto') {
        const m = minw.endsWith('%') ? outerAvail * parseFloat(minw) / 100 : (minw.endsWith('px') ? parseFloat(minw) : null);
        if (m != null) width = Math.max(width, m);
    }
    if (st['box-sizing'] === 'border-box') width = Math.max(0, width - pad[1] - pad[3] - border);
    const fs = Number(st['font-size']) || 16;
    const lh = typeof st['line-height'] === 'number' ? st['line-height'] : (parseFloat(st['line-height']) || 1.25);
    const text = String(node.text || '');
    const tw = textWidth(text, st);
    const nowrap = /nowrap|pre/.test(String(st['white-space']));
    const lines = Math.max(1, nowrap ? 1 : Math.ceil(tw / Math.max(1, width)));
    const autoH = Math.max(fs * lh, lines * fs * lh) + pad[0] + pad[2];
    let height = String(st.height || 'auto') === 'auto' ? autoH : (parseLength(st.height, { parent: fs, percentBase: (parentBox ? parentBox.height : viewport.h) }) || autoH);
    let x = parentX + mar[3] + pad[3];
    let y = parentY + mar[0] + pad[0];
    const positioned = st.position === 'absolute' || st.position === 'fixed';
    const fixed = st.position === 'fixed';
    const cbW = fixed ? viewport.w : parentW;
    const cbH = fixed ? viewport.h : (parentBox ? parentBox.height : viewport.h);
    const px = (v, base) => (v == null ? null : (parseLength(v, { parent: st['font-size'], percentBase: base }) || 0));
    const pTop = px(st.top, cbH); const pBottom = px(st.bottom, cbH);
    const pLeft = px(st.left, cbW); const pRight = px(st.right, cbW);
    if (positioned && String(st.height || 'auto') === 'auto' && pTop != null && pBottom != null) height = Math.max(0, cbH - pTop - pBottom - pad[0] - pad[2]);
    if (positioned && String(st.width || 'auto') === 'auto' && pLeft != null && pRight != null) width = Math.max(0, cbW - pLeft - pRight - pad[1] - pad[3]);
    if (positioned) {
        const baseX = fixed ? 0 : parentX; const baseY = fixed ? 0 : parentY;
        if (pLeft != null) x = baseX + pLeft;
        else if (pRight != null) x = baseX + cbW - pRight - width;
        if (pTop != null) y = baseY + pTop;
        else if (pBottom != null) y = baseY + cbH - pBottom - height;
    }
    return { x, y, width, height, contentW: width, right: x + width + pad[1], bottom: y + height + pad[2], textWidth: tw, lines, nowrap };
}

function analyze(root, { viewport, maxFindings = 200 } = {}) {
    const findings = [];
    const add = (kind, severity, node, detail, evidence) => {
        if (findings.length >= maxFindings) return;
        findings.push({ kind, severity, selector: selectorOf(node), detail, evidence });
    };
    const boxes = [];
    const positioned = [];
    const walk = (node, parentBox, depth) => {
        if (depth > 80 || findings.length >= maxFindings) return;
        if (!node.tag || node.tag === '#document') {
            for (const c of node.children || []) walk(c, parentBox, depth + 1);
            return;
        }
        const st = node.style;
        if (!st || st.display === 'none' || st.opacity === 0) return;
        const box = boxOf(node, parentBox, viewport);
        if (!box) return;
        node.box = box;
        boxes.push({ node, box });
        if (st.position === 'absolute' || st.position === 'fixed') positioned.push({ node, box });
        const text = String(node.text || '').trim();
        if (text) {
            // Boxes wider than the viewport, or content that does not fit the box it was given.
            if (box.width > viewport.w + 1 || box.right > viewport.w + 1) {
                add('overflow', 'medium', node, `the box is ${Math.round(box.width)}px wide and reaches ${Math.round(box.right)}px in a ${viewport.w}px viewport`, { width: Math.round(box.width), right: Math.round(box.right), viewport: viewport.w });
            }
            if (box.x < -1 || box.y < -1) {
                add('overflow', 'high', node, `the box starts outside the viewport at ${Math.round(box.x)}, ${Math.round(box.y)}`, { x: Math.round(box.x), y: Math.round(box.y) });
            }
            const hiddenX = /hidden|clip|scroll|auto/.test(String(st['overflow-x'] || st.overflow));
            if (hiddenX && box.textWidth > box.width + 2 && box.nowrap) {
                add('cut_off', 'high', node, `nowrap text is about ${Math.round(box.textWidth)}px wide inside a ${Math.round(box.width)}px box with overflow ${st['overflow-x'] || st.overflow}`, { text: text.slice(0, 120), textWidth: Math.round(box.textWidth), boxWidth: Math.round(box.width), overflow: st['overflow-x'] || st.overflow });
            }
            const explicitH = String(st.height || 'auto') !== 'auto' ? parseLength(st.height, { parent: st['font-size'], percentBase: (parentBox ? parentBox.height : viewport.h) }) : null;
            if (explicitH != null && box.lines * (Number(st['font-size']) || 16) * (typeof st['line-height'] === 'number' ? st['line-height'] : 1.25) > explicitH + 2 && /hidden|clip/.test(String(st.overflow))) {
                add('cut_off', 'medium', node, 'the text needs more lines than the fixed height allows and overflow is hidden', { lines: box.lines, height: Math.round(explicitH), overflow: st.overflow });
            }
            if (!hiddenX && box.nowrap && box.textWidth > viewport.w + 1) {
                add('overflow', 'medium', node, `nowrap text is about ${Math.round(box.textWidth)}px wide in a ${viewport.w}px viewport and can scroll the page sideways`, { text: text.slice(0, 120), textWidth: Math.round(box.textWidth), viewport: viewport.w });
            }
            // Contrast against the nearest painted background.
            if (!st['background-image']) {
                const layers = [];
                let bgNode = node; let unknown = false; let base = [255, 255, 255, 1];
                while (bgNode) {
                    const s2 = bgNode.style || {};
                    if (s2['background-image']) { unknown = true; break; }
                    const c = s2['background-color'];
                    if (c && c[3] > 0) {
                        layers.push(c);
                        if (c[3] >= 0.999) { base = c; break; }
                    }
                    bgNode = bgNode.parent;
                }
                // Composite the translucent layers from the outermost to the innermost over the opaque base.
                let bg = base;
                for (let i = layers.length - 1; i >= 0; i--) {
                    const l = layers[i];
                    bg = [0, 1, 2].map((k) => Math.round(l[k] * l[3] + bg[k] * (1 - l[3]))).concat(1);
                }
                if (!unknown) {
                    const fs = Number(st['font-size']) || 16;
                    const bold = Number(st['font-weight']) >= 700;
                    const large = fs >= 24 || (fs >= 18.66 && bold);
                    const required = large ? 3 : 4.5;
                    const ratio = contrastRatio(st.color, bg);
                    if (ratio + 0.01 < required) {
                        add('contrast', ratio < 3 ? 'high' : 'medium', node, `text contrast is ${ratio.toFixed(2)}:1 (needs ${required}:1 for ${large ? 'large' : 'body'} text)`, { ratio: Math.round(ratio * 100) / 100, required, color: colorCss(st.color), background: colorCss(bg), fontSize: fs, large });
                    }
                }
            }
        }
        // Layering faults that CSS itself states.
        const z = st['z-index'];
        if (z != null && (st.position === 'static' || !st.position)) {
            add('layering', 'low', node, `z-index ${z} has no effect while position is static`, { zIndex: z, position: st.position });
        }
        if (z != null && z < 0) {
            add('layering', 'medium', node, `a negative z-index (${z}) can put this box behind its parent's background`, { zIndex: z });
        }
        if (st.position === 'fixed' && box.width >= viewport.w * 0.9 && box.height >= viewport.h * 0.9 && (z == null || z >= 0)) {
            add('layering', 'medium', node, 'a fixed box covers at least 90% of the viewport; check that it is intended and dismissible', { width: Math.round(box.width), height: Math.round(box.height), zIndex: z });
        }
        for (const c of node.children || []) walk(c, box, depth + 1);
    };
    walk(root, null, 0);

    // Overlap between absolutely/fixed positioned boxes that are not ancestors of each other.
    for (let i = 0; i < positioned.length && findings.length < maxFindings; i++) {
        for (let j = i + 1; j < positioned.length && findings.length < maxFindings; j++) {
            const A = positioned[i]; const B = positioned[j];
            let a = A.node; let b = B.node; let related = false;
            while (a) { if (a === B.node) { related = true; break; } a = a.parent; }
            while (b && !related) { if (b === A.node) { related = true; break; } b = b.parent; }
            if (related) continue;
            const ix = Math.max(0, Math.min(A.box.right, B.box.right) - Math.max(A.box.x, B.box.x));
            const iy = Math.max(0, Math.min(A.box.bottom, B.box.bottom) - Math.max(A.box.y, B.box.y));
            const area = ix * iy;
            const smaller = Math.min(Math.max(1, A.box.width * A.box.height), Math.max(1, B.box.width * B.box.height));
            if (area > smaller * 0.25) {
                add('overlap', 'medium', A.node, `this positioned box overlaps ${selectorOf(B.node)} by ${Math.round(area / smaller * 100)}% of the smaller box`, { with: selectorOf(B.node), overlapPct: Math.round(area / smaller * 100) });
            }
        }
    }
    return findings;
}

function summarize(findings, { engine, viewport, source, url = null, warnings = [] } = {}) {
    const counts = {};
    const severity = { high: 0, medium: 0, low: 0 };
    for (const f of findings) { counts[f.kind] = (counts[f.kind] || 0) + 1; severity[f.severity] = (severity[f.severity] || 0) + 1; }
    return {
        ok: findings.length === 0,
        engine, source, ...(url ? { url } : {}), viewport,
        counts, severity, findings: findings.length,
        summary: findings.length
            ? `${findings.length} UI ${findings.length === 1 ? 'fault' : 'faults'} found (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`
            : 'No overflow, cut-off text, low contrast, overlap or layering fault was found by this pass.',
        warnings: [...new Set(warnings)].slice(0, 8),
    };
}

function checkHtml(html, { viewport = { w: 1280, h: 800 }, maxFindings = 200, source = 'html', url = null } = {}) {
    const parsed = parseHtml(html);
    const { rules, warnings } = parseRules(parsed.styles.join('\n'), viewport);
    createComputed(parsed.root, rules, viewport);
    const findings = analyze(parsed.root, { viewport, maxFindings });
    return { ...summarize(findings, { engine: 'static-html', viewport, source, url, warnings: [...parsed.warnings, ...warnings] }), findings };
}

async function fetchHtml(rawUrl, { config, fetchImpl = globalThis.fetch }) {
    const maxBytes = (config && config.ui && config.ui.maxHtmlBytes) || 1024 * 1024;
    const allowPrivate = Boolean(config && config.ui && config.ui.allowPrivate);
    const timeoutMs = (config && config.ui && config.ui.timeoutMs) || 10000;
    let url = await assertPublicUrl(rawUrl, { allowPrivate });
    for (let hop = 0; hop < 4; hop++) {
        let res;
        try { res = await fetchImpl(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'OpenVibe.Vision/0.1 UI check' } }); }
        catch (err) { const e = new Error(err && err.name === 'TimeoutError' ? 'the page did not answer in time' : 'the page could not be reached'); e.code = 'ui.unreachable'; throw e; }
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) { const e = new Error('the page redirected without a location'); e.code = 'ui.unreachable'; throw e; }
            url = await assertPublicUrl(new URL(loc, url).toString(), { allowPrivate });
            continue;
        }
        if (!res.ok) { const e = new Error(`the page answered ${res.status}`); e.code = 'ui.unreachable'; throw e; }
        const type = String(res.headers.get('content-type') || '').toLowerCase();
        const len = Number(res.headers.get('content-length'));
        if (Number.isFinite(len) && len > maxBytes) { const e = new Error('the page is larger than the UI check limit'); e.code = 'ui.too_large'; throw e; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) { const e = new Error('the page is larger than the UI check limit'); e.code = 'ui.too_large'; throw e; }
        const body = buf.toString('utf8');
        if (!/html|xhtml|text\/plain/.test(type) && !/^\s*<!doctype|^\s*<html/i.test(body)) { const e = new Error(`expected an HTML page, got ${type || 'an unknown type'}`); e.code = 'ui.not_html'; throw e; }
        return { html: body, url: url.toString() };
    }
    const e = new Error('too many redirects for that page'); e.code = 'ui.unreachable'; throw e;
}

/** Screenshot pass: OCR boxes at an edge, and the contrast inside each word box. */
async function checkScreenshot(buffer, { viewport = { w: 1280, h: 800 }, ocr, maxFindings = 200 } = {}) {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const width = Number(meta.width) || viewport.w;
    const height = Number(meta.height) || viewport.h;
    const findings = [];
    const warnings = ['a screenshot cannot show CSS layering or the DOM; the static-html pass does that'];
    if (ocr) {
        const read = await ocr.recognize(buffer).catch(() => null);
        if (read && read.ok) {
            const raw = await sharp(buffer, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const { data, info } = raw;
            for (const word of read.words || []) {
                if (findings.length >= maxFindings) break;
                const right = word.x + word.w; const bottom = word.y + word.h;
                if (right >= width - 2 || bottom >= height - 2 || word.x <= 1 || word.y <= 1) {
                    findings.push({ kind: 'cut_off', severity: right >= width - 2 ? 'high' : 'medium', selector: `text:"${word.text.slice(0, 40)}"`, detail: `the word "${word.text.slice(0, 60)}" sits at the edge of the ${width}×${height} screenshot and may be cut off`, evidence: { x: word.x, y: word.y, w: word.w, h: word.h, width, height } });
                }
                if (word.conf >= 40 && word.w > 3 && word.h > 3) {
                    let min = 1; let max = 0;
                    for (let y = Math.max(0, word.y); y < Math.min(info.height, word.y + word.h); y += Math.max(1, Math.floor(word.h / 12))) {
                        for (let x = Math.max(0, word.x); x < Math.min(info.width, word.x + word.w); x += Math.max(1, Math.floor(word.w / 16))) {
                            const i = (y * info.width + x) * info.channels;
                            const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
                            if (lum < min) min = lum;
                            if (lum > max) max = lum;
                        }
                    }
                    const ratio = (Math.max(min, max) + 0.05) / (Math.min(min, max) + 0.05);
                    const fs = word.h;
                    const required = fs >= 24 ? 3 : 4.5;
                    if (max - min > 0.05 && ratio < required) {
                        findings.push({ kind: 'contrast', severity: ratio < 3 ? 'high' : 'medium', selector: `text:"${word.text.slice(0, 40)}"`, detail: `the text "${word.text.slice(0, 60)}" measures about ${ratio.toFixed(2)}:1 against its background`, evidence: { ratio: Math.round(ratio * 100) / 100, required, x: word.x, y: word.y, w: word.w, h: word.h } });
                    }
                }
            }
            if (!(read.words || []).length) warnings.push('the screenshot contained no readable text for the OCR boxes; only the image size was checked');
        } else if (read && !read.ok) {
            warnings.push(`the OCR pass did not run: ${read.detail || read.code}`);
        }
    } else {
        warnings.push('no local OCR engine was available for the screenshot text boxes');
    }
    const out = summarize(findings, { engine: 'screenshot', viewport: { w: width, h: height }, source: 'screenshot', warnings });
    return { ...out, findings };
}

async function check(opts = {}) {
    const viewport = { w: Math.max(160, Math.min(10000, Number(opts.viewport && opts.viewport.w) || 1280)), h: Math.max(160, Math.min(10000, Number(opts.viewport && opts.viewport.h) || 800)) };
    const maxFindings = Math.min(500, Math.max(10, Number(opts.maxFindings) || 200));
    if (opts.imageBuffer) return checkScreenshot(opts.imageBuffer, { viewport, ocr: opts.ocr, maxFindings });
    if (opts.html) return checkHtml(opts.html, { viewport, maxFindings, source: 'html' });
    if (opts.url) {
        const fetched = await fetchHtml(opts.url, { config: opts.config, fetchImpl: opts.fetchImpl });
        return checkHtml(fetched.html, { viewport, maxFindings, source: 'url', url: fetched.url });
    }
    const e = new Error('send html, a URL or a screenshot image'); e.code = 'ui.input_required'; throw e;
}

module.exports = { check, checkHtml, checkScreenshot, fetchHtml, parseHtml, parseRules, analyze, contrastRatio, parseColor, textWidth };
