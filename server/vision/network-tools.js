'use strict';
const { VisionError } = require('./service');
const { forModel } = require('./images');

const receipt = (engine, model, ms, confidence, retention = 'not stored', cost = 0) => ({ engine, model, cost_usd: cost, ms, confidence, retention });
function parseReceipt(text) {
    const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const money = /(?:[$€£]\s*)?(\d+[.,]\d{2})\s*$/;
    const totalLine = [...lines].reverse().find((x) => /\b(total|amount due|balance due)\b/i.test(x) && money.test(x));
    const total = totalLine ? Number(totalLine.match(money)[1].replace(',', '.')) : null;
    const items = lines.filter((x) => money.test(x) && !/\b(total|tax|subtotal|balance|change|cash|card|payment|discount)\b/i.test(x)).map((x) => {
        const price = Number(x.match(money)[1].replace(',', '.'));
        const name = x.replace(money, '').trim();
        const qtyMatch = name.match(/^(\d+(?:\.\d+)?)\s*[xX×]\s+(.+)$/);
        return { name: qtyMatch ? qtyMatch[2] : name, qty: qtyMatch ? Number(qtyMatch[1]) : 1, price };
    }).filter((x) => x.name).slice(0, 100);
    const store = lines.find((x) => !money.test(x) && /[a-z]{3}/i.test(x)) || null;
    return { store, items, total };
}
function createNetworkTools({ s, ai, ocr, models, config, fetchImpl = fetch }) {
    async function routed(image, task, question) {
        if (!ai.enabled) throw new VisionError(503, 'vision.ai_unavailable', 'OpenVibe.AI is not configured');
        const normal = await forModel(image.buffer);
        try { return await ai.answer({ dataUrl: normal.dataUrl, task, question }); }
        catch (e) { throw new VisionError(e.status || 502, e.code || 'vision.ai_failed', e.detail || 'OpenVibe.AI could not answer'); }
    }
    async function alt(image) {
        const a = await routed(image, 'describe', 'Write one short, editable alt text sentence about the scene, objects and action. Describe people if they are in it, but never name someone or guess who they are.');
        const text = String(a.text).replace(/\s+/g, ' ').slice(0, 240);
        return { alt_text: text, editable: true, receipt: receipt('routed', a.model, a.ms, null, 'not stored', a.costUsd) };
    }
    async function index(owner, itemId, image, url) {
        const start = Date.now();
        if (!/^[\w:.-]{1,200}$/.test(String(itemId || ''))) throw new VisionError(400, 'vision.invalid_item', 'item_id must be 1–200 safe characters');
        if (url && (!/^https:\/\//.test(url) || url.length > 2000)) throw new VisionError(400, 'vision.invalid_url', 'result_url must be an HTTPS URL');
        const vector = await (await models.clip()).image(image.buffer);
        await s.db.query(`INSERT INTO vision_private_index (owner, item_id, result_url, image_sha256, embedding, created_at)
            VALUES ($1,$2,$3,$4,$5::jsonb,now()) ON CONFLICT (owner,item_id) DO UPDATE SET result_url=$3,image_sha256=$4,embedding=$5::jsonb,created_at=now()`,
            [owner, itemId, url || null, image.sha256, JSON.stringify(vector)]);
        return { item_id: itemId, receipt: receipt('local', 'CLIP ViT-B/32 q8', Date.now() - start, null, 'embedding stored; image not stored') };
    }
    async function find(owner, query) {
        const start = Date.now();
        const vector = typeof query === 'string' ? await (await models.clip()).text(query) : await (await models.clip()).image(query.buffer);
        // The owner predicate is mandatory on every DB read. JS cosine is the v1 pgvector-free scoring path.
        const rows = await s.db.many('SELECT item_id,result_url,embedding FROM vision_private_index WHERE owner=$1 ORDER BY created_at DESC LIMIT 5000', [owner]);
        const results = rows.map((r) => ({ item_id: r.item_id, result_url: r.result_url, score: models.cosine(vector, r.embedding) }))
            .filter((r) => Number.isFinite(r.score)).sort((a, b) => b.score - a.score).slice(0, 30);
        return { results, receipt: receipt('local', 'CLIP ViT-B/32 q8', Date.now() - start, results[0]?.score ?? null, 'query not stored; indexed embeddings stored') };
    }
    async function readReceipt(image, allowFallback) {
        const start = Date.now();
        const r = await ocr.recognize(image.buffer);
        if (!r.ok && !allowFallback) throw new VisionError(503, r.code || 'vision.ocr_unavailable', r.detail || 'local OCR is unavailable');
        if (r.ok && String(r.text || '').trim()) {
            const parsed = parseReceipt(r.text);
            if (parsed.items.length && parsed.total !== null) return { ...parsed, raw_text: r.text, receipt: receipt('local', 'Tesseract 5', Date.now() - start, r.confidence / 100) };
        }
        if (!allowFallback) throw new VisionError(422, 'vision.receipt_uncertain', 'local OCR could not extract line items and total; set fallback=true to use routed AI');
        const a = await routed(image, 'ocr', 'Read this receipt. Return JSON with store, items [{name,qty,price}], and total. Use null for missing values.');
        let parsed;
        try { parsed = JSON.parse(a.text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new VisionError(502, 'vision.receipt_invalid', 'routed model did not return receipt JSON'); }
        if (!Array.isArray(parsed.items)) throw new VisionError(502, 'vision.receipt_invalid', 'routed model omitted receipt items');
        return { store: String(parsed.store || '').slice(0, 150) || null, items: parsed.items.slice(0, 100).map((x) => ({ name: String(x.name || '').slice(0, 200), qty: Number(x.qty) || 1, price: Number(x.price) || 0 })), total: Number(parsed.total) || null, receipt: receipt('routed', a.model, Date.now() - start, null, 'not stored', a.costUsd) };
    }
    async function product(image, allowRerank) {
        const start = Date.now();
        const vector = await (await models.clip()).image(image.buffer);
        const a = await routed(image, 'identify', 'Describe this product only: visible type, brand if legible, colour and identifying features. Do not describe people. One short sentence.');
        const description = cleanAnswer(a.text).slice(0, 300);
        const offers = []; const warnings = [];
        for (const [name, base] of [['deals', config.offers.dealsUrl], ['open.shoes', config.offers.shoesUrl]]) {
            if (!base) { warnings.push(`${name} search API not configured`); continue; }
            try {
                const u = new URL(base); u.searchParams.set('q', description);
                const res = await fetchImpl(u, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
                if (!res.ok) throw new Error('HTTP error');
                const data = await res.json();
                const candidates = Array.isArray(data.offers) ? data.offers : Array.isArray(data.results) ? data.results : [];
                for (const c of candidates.slice(0, 20)) if (c && typeof (c.title || c.name) === 'string' && /^https:\/\//.test(c.url || '')) offers.push({ source: name, title: String(c.title || c.name).slice(0, 200), url: c.url, price: c.price ?? null });
            } catch { warnings.push(`${name} search unavailable`); }
        }
        const clip = await models.clip();
        for (const offer of offers) offer.score = models.cosine(vector, await clip.text(offer.title));
        offers.sort((x, y) => y.score - x.score);
        let rerankCost = 0;
        if (allowRerank && offers.length) {
            const ranked = await routed(image, 'identify', `Given this product photo, rank these candidate offer titles by visual match. Return a comma-separated list of candidate numbers only: ${offers.slice(0, 10).map((o, i) => `${i + 1}: ${o.title}`).join('; ')}`);
            rerankCost = ranked.costUsd;
            const order = ranked.text.match(/\d+/g)?.map(Number) || [];
            if (order.length) {
                const original = offers.slice();
                const unique = [...new Set(order.filter((n) => n >= 1 && n <= original.length))];
                offers.splice(0, offers.length, ...unique.map((n) => original[n - 1]), ...original.filter((_, i) => !unique.includes(i + 1)));
            }
        }
        return { description, embedding: vector, offers: offers.slice(0, 10), warnings, receipt: receipt(allowRerank && offers.length ? 'local+routed' : 'local+routed description', a.model, Date.now() - start, offers[0]?.score ?? null, 'not stored', a.costUsd + rerankCost) };
    }
    async function watch(image, classes, previous) {
        const start = Date.now();
        const wanted = classes.map((x) => String(x).toLowerCase());
        if (wanted.includes('scene change') && !previous) throw new VisionError(400, 'vision.previous_required', 'scene change needs previous_image');
        const detections = [];
        if (wanted.some((x) => x !== 'scene change')) {
            const found = await models.detect(image.buffer);
            for (const d of found) if (wanted.includes(String(d.label).toLowerCase())) detections.push({ class: d.label, confidence: d.score, box: d.box });
            const sceneClasses = wanted.filter((x) => ['snow', 'delivery', 'package'].includes(x));
            if (sceneClasses.length) {
                const clip = await models.clip();
                const imageVector = await clip.image(image.buffer);
                for (const label of sceneClasses) {
                    const prompt = label === 'snow' ? 'a snowy outdoor scene' : 'a delivery package at a door';
                    const score = models.cosine(imageVector, await clip.text(prompt));
                    if (score >= 0.25) detections.push({ class: label, confidence: score, box: null });
                }
            }
        }
        if (wanted.includes('scene change') && previous) {
            const diff = models.histogramDistance(await models.histogram(previous.buffer), await models.histogram(image.buffer));
            if (diff >= 0.22) detections.push({ class: 'scene change', confidence: Math.min(1, diff) });
        }
        return { detections, receipt: receipt('local', wanted.some((x) => x !== 'scene change') ? 'DETR ResNet-50 q8 + histogram' : 'histogram', Date.now() - start, detections[0]?.confidence ?? null) };
    }
    async function moments(frames, prompts) {
        const start = Date.now();
        const clip = await models.clip();
        const vectors = await Promise.all(prompts.map((p) => clip.text(p)));
        const scenes = []; const candidates = [];
        let previous = null;
        for (const frame of frames) {
            const hist = await models.histogram(frame.image.buffer);
            if (previous && models.histogramDistance(previous, hist) >= 0.22) scenes.push({ timestamp_ms: frame.timestamp_ms, kind: 'scene_change' });
            previous = hist;
            const embedding = await clip.image(frame.image.buffer);
            const scored = prompts.map((prompt, i) => ({ prompt, score: models.cosine(embedding, vectors[i]) })).sort((a, b) => b.score - a.score);
            if (scored[0] && scored[0].score >= 0.2) candidates.push({ timestamp_ms: frame.timestamp_ms, ...scored[0] });
        }
        return { scene_changes: scenes, candidate_moments: candidates.sort((a, b) => b.score - a.score).slice(0, 30), receipt: receipt('local', 'CLIP ViT-B/32 q8 + histogram', Date.now() - start, candidates[0]?.score ?? null) };
    }
    return { alt, index, find, readReceipt, product, watch, moments };
}
module.exports = { createNetworkTools, parseReceipt, receipt };
