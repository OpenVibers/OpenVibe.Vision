'use strict';
/**
 * The model list never keeps a visitor waiting (the 11-23 network crawl: /compare answered in 21 s, every visit waiting
 * for AI's routes to time out). ai.offeredModelsCached: at most maxWaitMs of waiting, one refresh at a time, the last good
 * list kept when a refresh fails, and a good list kept 10 minutes.
 *
 *   node test/models-cache.test.js
 */
const assert = require('assert');
const { createAi } = require('../server/vision/ai');

const ROUTES = { routes: [{ key: 'default.chat', capability: 'chat', primary: { provider: 'openai', model: 'gpt-5-mini' }, fallbacks: [{ provider: 'anthropic', model: 'claude-haiku-5-5' }] }] };

function fakeFetch({ delayMs = 0, fail = () => false } = {}) {
    const calls = { routes: 0, token: 0 };
    const fetchImpl = async (url) => {
        if (String(url).endsWith('/oauth/token')) {
            calls.token += 1;
            return new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        calls.routes += 1;
        await new Promise((r) => setTimeout(r, delayMs));
        if (fail()) return new Response(JSON.stringify({ error: 'down' }), { status: 503, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify(ROUTES), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetchImpl, calls };
}

const config = {
    ai: { url: 'http://ai.test', audience: 'openvibe.ai', scope: 'ai.run.create', timeoutMs: 30_000 },
    oauth: { clientId: 'vision', clientSecret: 's' }, networkInternalUrl: 'http://network.test',
};

(async () => {
    // A slow AI: the first visitor waits at most maxWaitMs and gets no list; the refresh finishes behind them.
    let clock = 1_000_000;
    const now = () => clock;
    const slow = fakeFetch({ delayMs: 300 });
    const ai = createAi({ config, fetchImpl: slow.fetchImpl, log: { warn() {} } });
    const t0 = Date.now();
    const first = await ai.offeredModelsCached({ maxWaitMs: 50, now });
    assert.ok(Date.now() - t0 < 250, `the first visitor waited ${Date.now() - t0} ms`);
    assert.deepStrictEqual(first, [], 'no list yet');
    const second = ai.offeredModelsCached({ maxWaitMs: 50, now });   // while the refresh runs: no second refresh
    await second;
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(slow.calls.routes, 1, 'one refresh at a time');
    const ready = await ai.offeredModelsCached({ maxWaitMs: 50, now });
    assert.deepStrictEqual(ready.map((m) => `${m.provider}:${m.model}`), ['openai:gpt-5-mini', 'anthropic:claude-haiku-5-5'], 'the list, from the cache');
    assert.strictEqual(slow.calls.routes, 1, 'kept: no new call');

    // After 10 minutes a refresh that fails keeps the last good list.
    let down = true;
    const flaky = fakeFetch({ fail: () => down });
    const ai2 = createAi({ config, fetchImpl: flaky.fetchImpl, log: { warn() {} } });
    down = false;
    assert.strictEqual((await ai2.offeredModelsCached({ maxWaitMs: 1000, now })).length, 2);
    clock += 11 * 60_000;
    down = true;
    assert.strictEqual((await ai2.offeredModelsCached({ maxWaitMs: 1000, now })).length, 2, 'the last good list when AI is down');
    console.log('models-cache: the model list never keeps a visitor waiting, and a good list outlives a failed refresh');
})().catch((e) => { console.error(e); process.exit(1); });
