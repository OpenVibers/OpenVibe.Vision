'use strict';

/**
 * The local reader: Tesseract 5, called as a child process with an argument array (never a shell). It is the
 * classical OCR step the plan names first; no image leaves this host and no model is called. A missing binary is
 * an honest 503 (`vision.ocr_unavailable`), not a silent cloud fallback.
 *
 * `recognize()` returns the text, the mean word confidence and the word boxes. The UI check's screenshot path
 * reuses the boxes to find text at an edge or under another box.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const { forOcr, withTempImage } = require('./images');

const run = promisify(execFile);
const LANG_RE = /^[a-z]{3}(?:\+[a-z]{3}){0,3}$/;

function parseTsv(tsv) {
    const words = [];
    const lines = new Map();
    for (const raw of String(tsv || '').split(/\r?\n/)) {
        if (!raw || /^level\t/.test(raw)) continue;
        const c = raw.split('\t');
        if (c.length < 12) continue;
        const level = Number(c[0]);
        if (level !== 5) continue;
        const text = String(c[11] == null ? '' : c[11]).trim();
        if (!text) continue;
        const conf = Number(c[10]);
        const box = { x: Number(c[6]) || 0, y: Number(c[7]) || 0, w: Number(c[8]) || 0, h: Number(c[9]) || 0 };
        const key = `${c[1]}/${c[2]}/${c[3]}/${c[4]}`;
        words.push({ text, conf: Number.isFinite(conf) ? conf : -1, ...box });
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push({ text, ...box });
    }
    const sorted = [...lines.entries()].sort((a, b) => {
        const ay = Math.min(...a[1].map((w) => w.y)); const by = Math.min(...b[1].map((w) => w.y));
        if (ay !== by) return ay - by;
        return Math.min(...a[1].map((w) => w.x)) - Math.min(...b[1].map((w) => w.x));
    });
    const text = sorted.map(([, ws]) => ws.sort((a, b) => a.x - b.x).map((w) => w.text).join(' ')).join('\n').trim();
    const scored = words.filter((w) => w.conf >= 0);
    const confidence = scored.length ? scored.reduce((n, w) => n + w.conf, 0) / scored.length : 0;
    return { text, confidence: Math.round(confidence * 10) / 10, words };
}

function createOcr({ config, log = console } = {}) {
    const bin = (config && config.ocr && config.ocr.bin) || 'tesseract';
    const lang = (config && config.ocr && config.ocr.lang) || 'eng';
    const timeoutMs = (config && config.ocr && config.ocr.timeoutMs) || 20000;
    let version = null;
    let checked = false;

    async function available() {
        if (checked) return version;
        checked = true;
        try {
            const { stdout } = await run(bin, ['--version'], { timeout: 5000, maxBuffer: 256 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT || '1' } });
            version = String(stdout || '').split('\n')[0].trim().slice(0, 120) || 'tesseract';
        } catch (err) {
            version = null;
            log.warn(`[OpenVibe.Vision] local OCR unavailable (${bin}): ${err && err.code === 'ENOENT' ? 'not installed' : String(err && err.message || err).slice(0, 120)}`);
        }
        return version;
    }

    function language(value) {
        const l = String(value || lang).trim();
        return LANG_RE.test(l) ? l : lang;
    }

    /**
     * OCR one image buffer. Never throws for a bad image or a missing binary: returns { ok, ... } so a route can
     * answer a stable problem code.
     */
    async function recognize(buffer, { lang: wanted = null } = {}) {
        const v = await available();
        if (!v) return { ok: false, code: 'vision.ocr_unavailable', detail: 'the local OCR engine (tesseract) is not installed on this host' };
        let png;
        try { png = await forOcr(buffer); }
        catch { return { ok: false, code: 'vision.image_invalid', detail: 'the image could not be decoded for OCR' }; }
        const started = Date.now();
        try {
            const { stdout } = await withTempImage(png.buffer, 'png', (file) => run(bin, [file, 'stdout', '-l', language(wanted), '--psm', '3', 'tsv'], {
                timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
                env: { ...process.env, OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT || '1' },
            }));
            const parsed = parseTsv(stdout);
            return { ok: true, engine: 'tesseract', version: v, ms: Date.now() - started, ...parsed };
        } catch (err) {
            if (err && err.killed) return { ok: false, code: 'vision.ocr_timeout', detail: 'the local OCR engine ran past its time limit' };
            log.warn(`[OpenVibe.Vision] local OCR failed: ${String(err && err.message || err).slice(0, 200)}`);
            return { ok: false, code: 'vision.ocr_failed', detail: 'the local OCR engine could not read that image' };
        }
    }

    return { recognize, available, parseTsv, bin, lang };
}

module.exports = { createOcr, parseTsv };
