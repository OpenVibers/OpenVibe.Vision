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
            assert.strictEqual(list.json().result.tools.length, 11);
            assert.ok(list.json().result.tools.some((x) => x.name === 'vision.blur_faces'));
            assert.ok(!list.json().result.tools.some((x) => /enrol|verify|cast/.test(x.name)));
        });

        await check('private tools challenge anonymous callers with resource metadata', async () => {
            const r = await t.get('/mcp', { json: rpc('tools/call', { name: 'vision.search_my_media', arguments: { query: 'desk' } }) });
            assert.strictEqual(r.status, 401, r.text);
            assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/openvibe.vision\/\.well-known\/oauth-protected-resource"/);
            assert.strictEqual(r.json().result.isError, true);
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
