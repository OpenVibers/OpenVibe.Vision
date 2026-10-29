'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { loadImage } = require('../vision/images');
const { check } = require('../vision/ui-check');
const { cleanAnswer } = require('../text/no-looks');
const { sameOrigin } = require('./principal');

const VERSION = '2025-06-18';
const VERSIONS = new Set([VERSION, '2025-03-26']);
const input = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const image = { image: { type: 'string', description: 'Image data URL' }, image_url: { type: 'string', description: 'Public HTTPS image URL' } };
const TOOLS = Object.freeze([
    { name: 'vision.ask_image', description: 'Ask about an image. Anonymous requests use local OCR only.', inputSchema: input({ ...image, question: { type: 'string' }, mode: { type: 'string', enum: ['auto', 'local', 'ai'] } }) },
    { name: 'vision.read_text', description: 'Read visible text with local OCR.', inputSchema: input({ ...image, lang: { type: 'string' } }) },
    { name: 'vision.translate_sign', description: 'Translate visible sign text through a routed model.', inputSchema: input({ ...image, lang: { type: 'string' } }) },
    { name: 'vision.find_similar', description: 'Search your private visual index by image.', inputSchema: input({ image: image.image }, ['image']) },
    { name: 'vision.search_my_media', description: 'Search your private visual index by words.', inputSchema: input({ query: { type: 'string' } }, ['query']) },
    { name: 'vision.describe_clip', description: 'Find scene changes and moments in your own frames.', inputSchema: input({ frames: { type: 'array', items: { type: 'object' } }, prompts: { type: 'array', items: { type: 'string' } } }, ['frames']) },
    { name: 'vision.detect_objects', description: 'Detect requested object classes in a source you own.', inputSchema: input({ image: image.image, classes: { type: 'array', items: { type: 'string' } } }, ['image', 'classes']) },
    { name: 'vision.blur_faces', description: 'Blur faces without identifying anyone.', inputSchema: input(image) },
    { name: 'vision.check_ui', description: 'Check a page or screenshot for layout and accessibility faults.', inputSchema: input({ ...image, html: { type: 'string' }, url: { type: 'string' }, viewport: { type: 'object' } }) },
    { name: 'vision.compare_models', description: 'Compare OCR with up to three routed model hints.', inputSchema: input({ ...image, question: { type: 'string' }, models: { type: 'array', items: { type: 'string' } } }) },
    { name: 'vision.get_job', description: 'Get a saved answer or UI check that you may read.', inputSchema: input({ id: { type: 'string' } }, ['id']) },
]);

const ACCESS = Object.freeze({
    'vision.ask_image': ['vision.image.ask', 'local'], 'vision.read_text': ['vision.text.read', 'anonymous'],
    'vision.translate_sign': ['vision.image.ask'], 'vision.find_similar': ['vision.media.find', 'person'],
    'vision.search_my_media': ['vision.media.find', 'person'], 'vision.describe_clip': ['vision.video.moments', 'person'],
    'vision.detect_objects': ['vision.camera.watch', 'person'], 'vision.blur_faces': ['vision.face.blur', 'anonymous'],
    'vision.check_ui': ['vision.ui.check', 'anonymous'], 'vision.compare_models': ['vision.model.compare'],
    'vision.get_job': ['vision.image.ask'],
});

function rpcResult(id, value) { return { jsonrpc: '2.0', id, result: value }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }; }
function toolResult(id, value) {
    if (value && typeof value.image === 'string' && value.image.startsWith('data:image/png;base64,')) {
        return rpcResult(id, { content: [
            { type: 'text', text: `Blurred ${value.count} face(s).` },
            { type: 'image', mimeType: 'image/png', data: value.image.slice('data:image/png;base64,'.length) },
        ], structuredContent: { count: value.count }, isError: false });
    }
    return rpcResult(id, { content: [{ type: 'text', text: cleanAnswer(JSON.stringify(value)) }], structuredContent: value, isError: false });
}
function toolError(id, message) { return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true }); }
function owner(req) { return req.principal && req.principal.kind === 'user' ? req.principal.subject : null; }
function access(req, name, ctx, args = {}) {
    let [cap, policy] = ACCESS[name];
    if (name === 'vision.get_job' && String(args.id || '').startsWith('vuc_')) cap = 'vision.ui.check';
    const p = req.principal;
    if (policy === 'person' && !owner(req)) return 'A verified owner user token is required.';
    if (p.kind === 'user') return p.viaSession && !sameOrigin(req, ctx.config.baseUrl) ? 'A signed-in change must come from Vision.' : null;
    if (p.kind === 'service') return cap && !ctx.principal.granted(p, cap) ? `${cap} not granted.` : null;
    if (policy === 'anonymous') return null;
    if (policy === 'local' && name === 'vision.ask_image') return null;
    return 'A Network token is required.';
}

async function invoke(name, args, req, ctx) {
    const { config, fetchImpl, vision, networkTools, faces, store, ocr } = ctx;
    const load = () => loadImage({ image: args.image, imageUrl: args.image_url, config, fetchImpl });
    const loadPrivate = () => {
        if (args.image_url || typeof args.image !== 'string' || !args.image.startsWith('data:image/')) throw new Error('Private tools accept an image data URL only.');
        return load();
    };
    const requester = req.principal.requester || 'anonymous';
    const subject = owner(req);
    const request = { requester, subject };
    switch (name) {
        case 'vision.ask_image': {
            const question = String(args.question || '').slice(0, 2000);
            const mode = req.principal.kind === 'anonymous' ? 'local' : (args.mode || 'auto');
            return { answer: await vision.ask({ ...request, image: await load(), task: 'ask', question, mode }) };
        }
        case 'vision.read_text': return await vision.ocr({ ...request, image: await load(), lang: args.lang, fallback: false });
        case 'vision.translate_sign': return { answer: await vision.ask({ ...request, image: await load(), task: 'translate', question: 'Translate the visible sign text.', mode: 'ai', lang: args.lang }) };
        case 'vision.find_similar': return { answer: await networkTools.find(subject, await loadPrivate()) };
        case 'vision.search_my_media': {
            if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500) throw new Error('query must contain 1–500 characters');
            return { answer: await networkTools.find(subject, args.query) };
        }
        case 'vision.describe_clip': {
            if (!Array.isArray(args.frames) || !args.frames.length || args.frames.length > 30) throw new Error('send 1–30 frames');
            const frames = [];
            for (const f of args.frames) {
                if (!Number.isFinite(f.timestamp_ms) || f.timestamp_ms < 0 || !f.image) throw new Error('each frame needs timestamp_ms and an image data URL');
                frames.push({ timestamp_ms: f.timestamp_ms, image: await loadImage({ image: f.image, config, fetchImpl }) });
            }
            return { answer: await networkTools.moments(frames, args.prompts) };
        }
        case 'vision.detect_objects': {
            if (!Array.isArray(args.classes) || !args.classes.length || args.classes.length > 20) throw new Error('send 1–20 classes');
            return { answer: await networkTools.watch(await loadPrivate(), args.classes) };
        }
        case 'vision.blur_faces': {
            const out = await faces.blur((await load()).buffer);
            return { count: out.count, image: `data:image/png;base64,${out.buffer.toString('base64')}` };
        }
        case 'vision.check_ui': {
            const viewport = args.viewport && typeof args.viewport === 'object' ? args.viewport : { w: 1280, h: 800 };
            const source = args.image || args.image_url ? { imageBuffer: (await load()).buffer } : args.html ? { html: args.html } : { url: args.url };
            if (!source.imageBuffer && !source.html && !source.url) throw new Error('send an image, html or url');
            return { check: await check({ ...source, viewport, config, fetchImpl, ocr, maxFindings: config.ui.maxFindings }) };
        }
        case 'vision.compare_models': return await vision.compare({ ...request, image: await load(), question: args.question || '', task: 'ask', models: args.models || [] });
        case 'vision.get_job': {
            const id = String(args.id || '');
            const ui = id.startsWith('vuc_');
            const row = ui ? await store.uiCheckById(id) : await store.answerById(id);
            const rowOwner = row && (ui ? await store.uiCheckSubject(id) : await store.answerSubject(id));
            if (!row || (req.principal.kind !== 'service' && (!subject || rowOwner !== subject))) throw new Error('No such result.');
            return ui ? { check: row } : { answer: row };
        }
        default: throw new Error('Unknown tool');
    }
}

function mcpRouter(ctx) {
    const r = express.Router();
    const metadata = `${ctx.config.baseUrl}/.well-known/oauth-protected-resource`;
    const challenge = (res, cap) => res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}"${cap ? `, scope="${cap}"` : ''}`);
    const document = () => ({ resource: `${ctx.config.baseUrl}/mcp`, authorization_servers: [ctx.config.networkUrl], scopes_supported: [...new Set(Object.values(ACCESS).map(([cap]) => cap).filter(Boolean))], bearer_methods_supported: ['header'], resource_documentation: `${ctx.config.baseUrl}/developers` });
    r.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(document()));
    r.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(document()));
    r.options('/mcp', (_req, res) => res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version' }).status(204).end());
    r.post('/mcp', rateLimit({ windowMs: 60_000, limit: Number(process.env.VISION_MCP_RATE_LIMIT_PER_MIN) || 60, standardHeaders: true, legacyHeaders: false }), express.json({ limit: `${Math.ceil(ctx.config.images.maxMb * 1.5) + 2}mb`, strict: false }), async (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        try {
            const resolved = await ctx.principal.resolve(req);
            if (resolved.error) { challenge(res); return res.status(resolved.error[0]).json(rpcError(null, -32001, resolved.error[2])); }
            req.principal = resolved.principal;
            if (req.get('mcp-protocol-version') && !VERSIONS.has(req.get('mcp-protocol-version'))) return res.status(400).json(rpcError(null, -32600, 'Unsupported protocol version'));
            const batch = Array.isArray(req.body);
            const messages = batch ? req.body : [req.body];
            if (!messages.length) return res.json(rpcError(null, -32600, 'Invalid Request'));
            const responses = [];
            for (const msg of messages) {
                if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (Object.hasOwn(msg, 'id') && !(msg.id === null || typeof msg.id === 'string' || Number.isFinite(msg.id)))) { responses.push(rpcError(null, -32600, 'Invalid Request')); continue; }
                if (!Object.hasOwn(msg, 'id')) continue;
                const id = msg.id, params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
                if (msg.method === 'initialize') responses.push(rpcResult(id, { protocolVersion: VERSIONS.has(params.protocolVersion) ? params.protocolVersion : VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'openvibe-vision', version: require('../../package.json').version } }));
                else if (msg.method === 'ping') responses.push(rpcResult(id, {}));
                else if (msg.method === 'tools/list') responses.push(rpcResult(id, { tools: TOOLS }));
                else if (msg.method === 'tools/call') {
                    const name = params.name;
                    if (!Object.hasOwn(ACCESS, name)) { responses.push(rpcError(id, -32602, 'Unknown tool')); continue; }
                    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
                    const denied = access(req, name, ctx, args);
                    if (denied) {
                        if (req.principal.kind === 'anonymous') challenge(res, name === 'vision.get_job' && String(args.id || '').startsWith('vuc_') ? 'vision.ui.check' : ACCESS[name][0]);
                        responses.push(toolError(id, denied)); continue;
                    }
                    try { responses.push(toolResult(id, await invoke(name, args, req, ctx))); }
                    catch (err) { responses.push(toolError(id, err.detail || err.message || 'Tool failed')); }
                } else responses.push(rpcError(id, -32601, 'Method not found'));
            }
            if (!responses.length) return res.status(202).end();
            return res.status(res.getHeader('WWW-Authenticate') ? 401 : 200).json(batch ? responses : responses[0]);
        } catch (err) { next(err); }
    });
    r.all('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).json(rpcError(null, -32600, 'Method Not Allowed')));
    r.use((err, _req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return res.status(400).json(rpcError(null, -32700, 'Parse error'));
        if (err && err.type === 'entity.too.large') return res.status(413).json(rpcError(null, -32600, 'Request body too large'));
        next(err);
    });
    return r;
}

module.exports = { mcpRouter, TOOLS };
