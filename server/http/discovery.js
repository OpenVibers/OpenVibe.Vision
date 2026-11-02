'use strict';

/**
 * Crawl artifacts for openvibe.vision: robots.txt, sitemap.xml, llms.txt and llms-full.txt. The public pages are
 * for search engines and AI crawlers; sign-in, the API, the internal route, saved answers and saved UI checks are
 * not (a saved answer belongs to the person who asked). v1 has no public objects, so the sitemap has no per-record
 * URLs.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Vision';
const DESCRIPTION = 'OpenVibe.Vision reads images and checks pages. Local face detection and blur are open; identifying matches require separate, purpose-scoped consent.';
const DISALLOW = ['/auth/', '/api/', '/internal', '/metrics', '/a/', '/ui/'];

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'MultimediaApplication', keywords: 'openvibe vision, image understanding, OCR, tesseract, vision models, UI check, contrast, overflow' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

function publicPages() {
    return [
        { path: '/', changefreq: 'daily', priority: 1.0, title: 'OpenVibe.Vision home', text: 'Ask a picture, compare models, read text with the local OCR engine, and check a page for UI faults.' },
        { path: '/ask', changefreq: 'weekly', priority: 0.9, title: 'Ask a picture', text: 'Upload an image or paste a public URL and ask what it shows.' },
        { path: '/read', changefreq: 'weekly', priority: 0.9, title: 'Read text from a picture', text: 'Read a receipt, sign, label or screenshot with the local OCR engine; free, and the picture is not stored.' },
        { path: '/find', changefreq: 'weekly', priority: 0.8, title: 'Find a picture by words', text: 'Search only your own pictures by describing them; owner-checked on every read and never a public index.' },
        { path: '/watch', changefreq: 'weekly', priority: 0.8, title: 'Watch a camera still', text: 'Find a package, a delivery, a person or a car in a camera still with local object detection.' },
        { path: '/ocr', changefreq: 'weekly', priority: 0.8, title: 'Read text from a picture', text: 'Local Tesseract OCR first, with an optional AI fallback for a signed-in person.' },
        { path: '/compare', changefreq: 'weekly', priority: 0.8, title: 'Compare models side by side', text: 'The same image through local OCR and through OpenVibe.AI, with the answer, cost and latency side by side.' },
        { path: '/ui-check', changefreq: 'weekly', priority: 0.9, title: 'Check a page for UI faults', text: 'Overflow, cut-off text, low contrast, overlap and layering faults from HTML, a URL or a screenshot.' },
        { path: '/people', changefreq: 'weekly', priority: 0.6, title: 'People and consent', text: 'Separate choices for self verification, self search, cast tagging and private library grouping.' },
        { path: '/privacy', changefreq: 'yearly', priority: 0.3, title: 'Privacy policy', text: 'The privacy policy for OpenVibe.Vision.' },
        { path: '/people/privacy', changefreq: 'weekly', priority: 0.6, title: 'Face privacy', text: 'Local processing, private links, retention, erasure and prohibited uses.' },
        { path: '/developers', changefreq: 'weekly', priority: 0.6, title: 'The OpenVibe.Vision API', text: 'The JSON API, the capabilities other services need, and what leaves this host.' },
    ];
}

function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });
    const pages = publicPages();

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.vision: the public pages are for search and AI crawlers; sign-in, the API, saved answers and the internal route are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Vision answers questions about a picture, reads text locally and checks UI faults. Local face detection and blur need no identity; self verification, self search, cast tagging and library grouping each require separate consent. AI may describe people, including how they look; a stranger is never looked up.',
            details: 'POST /api/v1/ask (multipart image, image data URL or image_url) asks a question. POST /api/v1/ocr reads text locally first. POST /api/v1/compare runs the same image through local OCR and up to three AI hints. POST /api/v1/ui-check takes html, url or a screenshot and returns findings. GET /api/v1/benchmarks aggregates compare samples without subjects. Face detection/blur are open at POST /api/v1/faces/detect and /blur; matching needs separate signed consent per purpose (verify, find, cast, library). A person is the openvibe.vision session or a Network user token; a service token needs vision.ask, vision.ocr, vision.compare, vision.ui.check or vision.face.cast.match.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Vision', url: abs('/') },
                    { title: 'Ask a picture', url: abs('/ask') },
                    { title: 'Read text from a picture', url: abs('/read') },
                    { title: 'Find your own picture', url: abs('/find') },
                    { title: 'Watch a camera still', url: abs('/watch') },
                    { title: 'Compare models', url: abs('/compare') },
                    { title: 'The UI check', url: abs('/ui-check') },
                    { title: 'People and consent', url: abs('/people') },
                    { title: 'Face privacy', url: abs('/people/privacy') },
                    { title: 'The API', url: abs('/developers') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Benchmark results (JSON)', url: abs('/api/v1/benchmarks') },
                    { title: 'Model hints (JSON)', url: abs('/api/v1/models') },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.AI', url: 'https://ai.openvibe.services', note: 'the routing, quotas and provenance every model answer uses' },
                    { title: 'OpenVibe.Design', url: 'https://openvibe.design', note: 'the Arena that calls the UI check' },
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, tokens and staff roles' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Vision: the home, ask, OCR, compare, the UI check, people and consent, face privacy and the API.',
            base: site,
            maxBytes: 256 * 1024,
            sections: [
                { title: 'Pages', pages: pages.map((p) => ({ url: p.path, title: p.title, text: p.text })) },
                { title: 'Rules', pages: [
                    { url: '/people/privacy', title: 'Faces with consent', text: 'Face matching is local and limited to a separately consented purpose. AI may describe people; a stranger is never looked up.' },
                    { url: '/developers', title: 'No stored general images', text: 'General answers store a sha256, the media type and the cleaned text, never the image bytes. Only an opt-in face library keeps encrypted uploads.' },
                ] },
            ],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = pages.map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
