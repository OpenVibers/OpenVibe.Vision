'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

(async () => {
    const t = await boot();
    const owner = t.network.addUser('mcp-owner');
    try {
        await check('MCP advertises RFC 9728 metadata and its supported tools', async () => {
            const meta = await t.get('/.well-known/oauth-protected-resource');
            assert.strictEqual(meta.status, 200);
            assert.strictEqual(meta.json().resource, 'https://openvibe.vision/mcp');
            assert.deepStrictEqual(meta.json().authorization_servers, ['http://' + new URL(t.network.url).host]);
            const init = await t.get('/mcp', { json: rpc('initialize', { protocolVersion: '2025-06-18' }) });
            assert.strictEqual(init.status, 200, init.text);
            assert.strictEqual(init.json().result.serverInfo.name, 'openvibe-vision');
            const list = await t.get('/mcp', { json: rpc('tools/list') });
            assert.strictEqual(list.json().result.tools.length, 17);
            for (const name of ['vision.meal', 'vision.describe_surroundings', 'vision.identify_plant', 'vision.identify_landmark', 'vision.screenshot_components']) {
                assert.ok(list.json().result.tools.some((x) => x.name === name), `VIS-6 tool ${name}`);
            }
            assert.ok(list.json().result.tools.some((x) => x.name === 'vision.blur_faces'));
            assert.ok(!list.json().result.tools.some((x) => /enrol|verify|cast/.test(x.name)));
        });

        await check('MCP 2026-07-28 beside the handshake era: discover, list, call, headers checked (openvibe-sdk/mcp)', async () => {
            const mcp = require('openvibe-sdk/mcp');
            // The boot helper sets content-type itself for a json body.
            const send = (method, params = {}, extra = {}, version) => {
                const m = mcp.modernRequest({ id: 7, method, params, ...(version ? { version } : {}) });
                const headers = { ...m.headers, ...extra };
                delete headers['Content-Type'];
                return t.get('/mcp', { json: m.body, headers });
            };
            const disc = await send('server/discover');
            assert.strictEqual(disc.status, 200, disc.text);
            assert.strictEqual(disc.json().result.resultType, 'complete');
            assert.ok(disc.json().result.supportedVersions.includes('2026-07-28'));
            const list = (await send('tools/list')).json().result;
            assert.deepStrictEqual([list.resultType, list.cacheScope, list.tools.length], ['complete', 'public', 17]);
            const ocr = await send('tools/call', { name: 'vision.search_my_media', arguments: { query: 'desk' } });
            assert.strictEqual(ocr.status, 401, 'anonymous: the same challenge as before');
            assert.strictEqual(ocr.json().result.resultType, 'complete');
            let r = await send('tools/list', {}, { 'Mcp-Method': 'tools/call' });
            assert.deepStrictEqual([r.status, r.json().error.code], [400, -32020]);
            r = await send('tools/list', {}, {}, '2027-01-01');
            assert.strictEqual(r.status, 400);
            r = await send('prompts/list');
            assert.deepStrictEqual([r.status, r.json().error.code], [404, -32601]);
            const init = await t.get('/mcp', { json: rpc('initialize', { protocolVersion: '2026-07-28' }) });
            assert.strictEqual(init.json().result.protocolVersion, '2025-06-18', 'initialize answers in the handshake era');
        });

        await check('private tools challenge anonymous callers with resource metadata', async () => {
            const r = await t.get('/mcp', { json: rpc('tools/call', { name: 'vision.search_my_media', arguments: { query: 'desk' } }) });
            assert.strictEqual(r.status, 401, r.text);
            assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/openvibe.vision\/\.well-known\/oauth-protected-resource"/);
            assert.strictEqual(r.json().result.isError, true);
        });

        await check('a delegated person token (SDK 0.187) is the person on /mcp, and only there', async () => {
            const call = (token) => t.get('/mcp', { bearer: token, json: rpc('tools/call', { name: 'vision.search_my_media', arguments: { query: 'desk' } }) });
            const asKey = await call(t.network.delegatedToken(owner, { services: ['vision'] }));
            assert.strictEqual(asKey.status, 200, asKey.text);
            assert.ok(!/A verified owner user token is required/.test(asKey.text), asKey.text);
            const forDesign = await call(t.network.delegatedToken(owner, { services: ['design'] }));
            assert.strictEqual(forDesign.status, 401, 'a token for another service is refused here');
            const api = await t.get('/api/v1/find?q=desk', { bearer: t.network.delegatedToken(owner, { services: ['vision'] }) });
            assert.strictEqual(api.status, 401, `the API takes no delegated token: ${api.status} ${api.text.slice(0, 200)}`);
        });

        await check('a service token needs the exact tool capability', async () => {
            const denied = await t.get('/mcp', { bearer: t.network.serviceToken({ cap: ['vision.ui.check'] }), json: rpc('tools/call', { name: 'vision.compare_models', arguments: {} }) });
            assert.strictEqual(denied.status, 200);
            assert.strictEqual(denied.json().result.isError, true);
            assert.match(denied.json().result.content[0].text, /vision.model.compare/);
        });

        await check('private image tools refuse a remote source before fetching it', async () => {
            const r = await t.get('/mcp', { bearer: t.network.userToken(owner), json: rpc('tools/call', { name: 'vision.find_similar', arguments: { image_url: t.images.url + '/image.png' } }) });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json().result.isError, true);
            assert.match(r.json().result.content[0].text, /image data URL only/);
        });

        await check('VIS-6: a prompted tool runs its task through the routed model and saves it as that task', async () => {
            const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const r = await t.get('/mcp', { bearer: t.network.userToken(owner), json: rpc('tools/call', { name: 'vision.identify_plant', arguments: { image: tiny } }) });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().result.isError, false, r.text);
            assert.strictEqual(r.json().result.structuredContent.answer.task, 'plant');
            const sent = t.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').pop();
            assert.match(JSON.stringify(sent.body.messages[0].content), /scientific name/);
        });

        await check('an owner may read their own UI check, while another owner cannot', async () => {
            const saved = await t.get('/api/v1/ui-check', { as: owner, json: { html: '<div>hello</div>' } });
            assert.strictEqual(saved.status, 201, saved.text);
            const id = saved.json().check.id;
            const own = await t.get('/mcp', { bearer: t.network.userToken(owner), json: rpc('tools/call', { name: 'vision.get_job', arguments: { id } }) });
            assert.strictEqual(own.json().result.isError, false, own.text);
            assert.strictEqual(own.json().result.structuredContent.check.id, id);
            const other = t.network.addUser('mcp-other');
            const refused = await t.get('/mcp', { bearer: t.network.userToken(other), json: rpc('tools/call', { name: 'vision.get_job', arguments: { id } }) });
            assert.strictEqual(refused.json().result.isError, true);
            assert.strictEqual(refused.json().result.content[0].text, 'No such result.');
        });

        await check('notifications, batches and parse errors follow JSON-RPC', async () => {
            const batch = await t.get('/mcp', { json: [rpc('ping', {}, 1), rpc('tools/list', {}, 2)] });
            assert.strictEqual(batch.status, 200);
            assert.strictEqual(batch.json().length, 2);
            const notification = await t.get('/mcp', { json: { jsonrpc: '2.0', method: 'notifications/initialized' } });
            assert.strictEqual(notification.status, 202);
            const malformed = await t.get('/mcp', { body: '{', headers: { 'content-type': 'application/json' } });
            assert.strictEqual(malformed.status, 400);
            assert.strictEqual(malformed.json().error.code, -32700);
        });
    } finally { await t.close(); }
    done();
})();
