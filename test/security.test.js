'use strict';
/**
 * The public-URL guard, token audiences and signatures, and the promise that no secret is rendered or logged.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { assertPublicUrl, isPrivateAddress, loadImage } = require('../server/vision/images');

(async () => {
    await check('private, loopback, link-local and unique-local addresses are refused', async () => {
        for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '0.0.0.0']) assert.strictEqual(isPrivateAddress(a), true, a);
        for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.strictEqual(isPrivateAddress(a), false, a);
        await assert.rejects(assertPublicUrl('http://127.0.0.1/x', { allowPrivate: false }), (e) => e.code === 'image.private_url');
        await assert.rejects(assertPublicUrl('file:///etc/passwd'), (e) => e.code === 'image.invalid_url');
        await assert.rejects(assertPublicUrl('https://user:pass@example.com/x'), (e) => e.code === 'image.invalid_url');
    });

    const t = await boot();
    const user = t.network.addUser('kim');
    try {
        await check('loadImage refuses a private URL unless the host explicitly allows it', async () => {
            await assert.rejects(loadImage({ imageUrl: `${t.images.url}/image.png`, config: { images: { maxMb: 8, timeoutMs: 2000, allowPrivate: false } }, fetchImpl: t.fetchImpl }), (e) => e.code === 'image.private_url');
            const ok = await loadImage({ imageUrl: `${t.images.url}/image.png`, config: { images: { maxMb: 8, timeoutMs: 2000, allowPrivate: true } } });
            assert.strictEqual(ok.source, 'url');
            assert.strictEqual(ok.mime, 'image/png');
            assert.match(ok.sha256, /^[0-9a-f]{64}$/);
        });

        await check('a service token for another audience and a forged token are 401', async () => {
            const wrongAud = t.network.serviceToken({ sub: 'svc:design', cap: ['vision.ui.check'], audience: 'openvibe.design' });
            const r = await t.get('/api/v1/ui-check', { bearer: wrongAud, json: { html: '<p>x</p>' } });
            assert.strictEqual(r.status, 401);
            const forged = t.network.serviceToken({ sub: 'svc:design', cap: ['vision.ui.check'] }).slice(0, -2) + 'aa';
            assert.strictEqual((await t.get('/api/v1/ui-check', { bearer: forged, json: { html: '<p>x</p>' } })).status, 401);
        });

        await check('the session cookie never appears in a page or /auth/me, and the logs carry no token', async () => {
            const token = t.network.userToken(user);
            const page = await t.get('/', { cookie: `vision_at=${token}` });
            assert.strictEqual(page.status, 200);
            assert.ok(!page.text.includes(token));
            const me = await t.get('/auth/me', { cookie: `vision_at=${token}` });
            assert.ok(!me.text.includes(token));
            assert.ok(!t.logs().includes(token));
            assert.ok(!t.logs().includes('vision-secret'));
        });

        await check('an image URL that redirects to a private address is still refused when the guard is on', async () => {
            const local = { images: { maxMb: 8, timeoutMs: 2000, allowPrivate: false } };
            await assert.rejects(loadImage({ imageUrl: `${t.images.url}/redirect`, config: local }), (e) => e.code === 'image.private_url');
        });
    } finally {
        await t.close();
    }
    done();
})();
