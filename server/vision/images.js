'use strict';

/**
 * Image inputs. An API caller may upload bytes (multipart), send a data: URI, or name a public https URL.
 * The URL path is fetched only after every resolved address is checked: loopback, link-local, private and
 * unique-local addresses are refused (SSRF), redirects are re-checked, and the bytes must really be an image.
 *
 * Nothing here stores an image. The answer writes only sha256, mime and byte count; OCR gets a temporary file
 * that is removed in a finally block.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp|gif|bmp|tiff|avif));base64,([A-Za-z0-9+/=\s]+)$/i;
const MIME_BY_MAGIC = [
    { mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG' },
    { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { mime: 'image/webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
    { mime: 'image/gif', test: (b) => b.length > 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') },
    { mime: 'image/bmp', test: (b) => b.length > 2 && b.toString('ascii', 0, 2) === 'BM' },
    { mime: 'image/tiff', test: (b) => b.length > 4 && (b.toString('ascii', 0, 2) === 'II' || b.toString('ascii', 0, 2) === 'MM') },
    { mime: 'image/avif', test: (b) => b.length > 12 && b.toString('ascii', 4, 12) === 'ftypavif' },
];

function isPrivateAddress(address) {
    if (!net.isIP(address)) return true;
    if (net.isIPv4(address)) {
        const p = address.split('.').map(Number);
        if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
        if (p[0] === 169 && p[1] === 254) return true;
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
        if (p[0] === 192 && p[1] === 168) return true;
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
        if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;
        if (p[0] >= 224) return true;
        return false;
    }
    const a = address.toLowerCase();
    if (a === '::' || a === '::1') return true;
    if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true;
    if (a.startsWith('fc') || a.startsWith('fd')) return true;
    if (a.startsWith('ff')) return true;
    if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));
    return false;
}

async function assertPublicUrl(raw, { allowPrivate = false } = {}) {
    let u;
    try { u = new URL(String(raw)); } catch { const e = new Error('that image URL is not a URL'); e.code = 'image.invalid_url'; throw e; }
    if (!/^https?:$/.test(u.protocol)) { const e = new Error('an image URL must be http or https'); e.code = 'image.invalid_url'; throw e; }
    if (u.username || u.password) { const e = new Error('an image URL may not carry credentials'); e.code = 'image.invalid_url'; throw e; }
    if (!allowPrivate) {
        const host = u.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(host)) {
            if (isPrivateAddress(host)) { const e = new Error('that address is private; Vision fetches public images only'); e.code = 'image.private_url'; throw e; }
        } else {
            let rows;
            try { rows = await dns.lookup(host, { all: true, verbatim: true }); } catch { const e = new Error('that image host does not resolve'); e.code = 'image.unreachable'; throw e; }
            if (!rows.length || rows.some((r) => isPrivateAddress(r.address))) {
                const e = new Error('that host resolves to a private address; Vision fetches public images only');
                e.code = 'image.private_url';
                throw e;
            }
        }
    }
    return u;
}

function sniff(buffer) {
    for (const m of MIME_BY_MAGIC) if (m.test(buffer)) return m.mime;
    return null;
}

function decodeDataUrl(dataUrl, maxBytes) {
    const m = DATA_URL_RE.exec(String(dataUrl || '').trim());
    if (!m) { const e = new Error('image must be a base64 data:image/png|jpeg|webp|gif|bmp|tiff|avif URL'); e.code = 'image.invalid'; throw e; }
    const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (!buffer.length) { const e = new Error('the image data is empty'); e.code = 'image.invalid'; throw e; }
    if (buffer.length > maxBytes) { const e = new Error('that image is larger than the limit'); e.code = 'image.too_large'; throw e; }
    const mime = sniff(buffer);
    if (!mime) { const e = new Error('the data URL does not contain a supported image'); e.code = 'image.unsupported'; throw e; }
    return { buffer, mime };
}

async function readBody(res, maxBytes) {
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\//.test(type)) { const e = new Error(`expected an image, got ${type || 'an unknown type'}`); e.code = 'image.not_image'; throw e; }
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) { const e = new Error('that image is larger than the limit'); e.code = 'image.too_large'; throw e; }
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (!buffer.length) { const e = new Error('the image URL answered with no bytes'); e.code = 'image.empty'; throw e; }
    if (buffer.length > maxBytes) { const e = new Error('that image is larger than the limit'); e.code = 'image.too_large'; throw e; }
    const mime = sniff(buffer);
    if (!mime) { const e = new Error('the URL did not answer with a supported image'); e.code = 'image.unsupported'; throw e; }
    return { buffer, mime };
}

async function fetchImage(rawUrl, { fetchImpl = globalThis.fetch, timeoutMs = 10000, maxBytes = 8 * 1024 * 1024, allowPrivate = false } = {}) {
    let url = await assertPublicUrl(rawUrl, { allowPrivate });
    for (let hop = 0; hop < 4; hop++) {
        let res;
        try { res = await fetchImpl(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'image/*', 'User-Agent': 'OpenVibe.Vision/0.1 image reader' } }); }
        catch (err) { const e = new Error(err && err.name === 'TimeoutError' ? 'the image host did not answer in time' : 'the image host could not be reached'); e.code = err && err.name === 'TimeoutError' ? 'image.timeout' : 'image.unreachable'; throw e; }
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) { const e = new Error('the image host redirected without a location'); e.code = 'image.unreachable'; throw e; }
            url = await assertPublicUrl(new URL(loc, url).toString(), { allowPrivate });
            continue;
        }
        if (!res.ok) { const e = new Error(`the image host answered ${res.status}`); e.code = 'image.unreachable'; throw e; }
        return await readBody(res, maxBytes);
    }
    const e = new Error('too many redirects for that image'); e.code = 'image.unreachable'; throw e;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * The one entry point routes use. opts: file (multer buffer), contentType, imageUrl, image (data URL or plain
 * base64), fetchImpl, timeoutMs, maxMb, allowPrivate.
 */
async function loadImage(opts = {}) {
    const config = opts.config || {};
    const maxMb = Math.min(20, Math.max(1, Number(opts.maxMb || (config.images && config.images.maxMb) || 8)));
    const maxBytes = maxMb * 1024 * 1024;
    const timeoutMs = Number(opts.timeoutMs || (config.images && config.images.timeoutMs) || 10000);
    const allowPrivate = opts.allowPrivate != null ? opts.allowPrivate : Boolean(config.images && config.images.allowPrivate);

    let buffer; let mime; let source; let sourceUrl = null;
    if (opts.file) {
        buffer = Buffer.from(opts.file);
        mime = sniff(buffer);
        if (!mime) { const e = new Error('that file is not a supported image'); e.code = 'image.unsupported'; throw e; }
        if (buffer.length > maxBytes) { const e = new Error('that image is larger than the limit'); e.code = 'image.too_large'; throw e; }
        source = 'upload';
    } else if (opts.imageUrl) {
        const got = await fetchImage(opts.imageUrl, { fetchImpl: opts.fetchImpl, timeoutMs, maxBytes, allowPrivate });
        buffer = got.buffer; mime = got.mime; source = 'url'; sourceUrl = String(opts.imageUrl).slice(0, 2048);
    } else if (opts.image) {
        const got = decodeDataUrl(opts.image, maxBytes);
        buffer = got.buffer; mime = got.mime; source = 'data';
    } else {
        const e = new Error('send an image file, an image data URL, or image_url'); e.code = 'image.required'; throw e;
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/avif'].includes(mime)) {
        const e = new Error('that image type is not supported'); e.code = 'image.unsupported'; throw e;
    }
    // A compressed image can decode to an enormous surface. 40 MP is far beyond a screenshot or a photo a person
    // asks about, and keeps the local passes (sharp pixels, Tesseract) inside a predictable memory budget.
    try {
        const meta = await sharp(buffer, { failOn: 'none', limitInputPixels: 40_000_000 }).metadata();
        if (!meta || !meta.width || !meta.height) throw new Error('no dimensions');
    } catch {
        const e = new Error('that image could not be decoded (or is larger than 40 megapixels)'); e.code = 'image.invalid'; throw e;
    }
    return { buffer, mime, bytes: buffer.length, sha256: sha256(buffer), source, sourceUrl };
}

/** Normalise for a vision model: rotate by EXIF, fit inside 1536 px, JPEG (the form every provider reads). */
async function forModel(buf) {
    const out = await sharp(buf, { failOn: 'none', animated: false })
        .rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 }).toBuffer();
    return { buffer: out, mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${out.toString('base64')}` };
}

/** Normalise for Tesseract: rotate, grayscale, normalise contrast, fit inside 4000 px, PNG. */
async function forOcr(buf) {
    const out = await sharp(buf, { failOn: 'none', animated: false })
        .rotate().resize({ width: 4000, height: 4000, fit: 'inside', withoutEnlargement: true })
        .grayscale().normalise().png().toBuffer();
    return { buffer: out, mime: 'image/png' };
}

/** Metadata for a screenshot answer; no bytes are kept. */
async function metadata(buf) {
    const m = await sharp(buf, { failOn: 'none' }).metadata();
    return { width: Number(m.width) || 0, height: Number(m.height) || 0, format: m.format || null };
}

async function withTempImage(buffer, ext, fn) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openvibe-vision-'));
    const file = path.join(dir, `image.${ext || 'png'}`);
    try {
        await fs.promises.writeFile(file, buffer);
        return await fn(file);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

module.exports = {
    loadImage, fetchImage, assertPublicUrl, isPrivateAddress, sniff, sha256,
    forModel, forOcr, metadata, withTempImage,
};
