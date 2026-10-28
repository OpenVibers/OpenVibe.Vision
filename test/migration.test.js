'use strict';
/**
 * The expand migration applies in one pass and creates exactly the Vision tables, plus the SDK's account receipts
 * and telemetry. The answer constraints refuse a bad id, a task outside v1 and an unknown engine.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('0001_initial.sql applies and creates the Vision tables', async () => {
            const names = (await t.ctx.s.db.many("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).map((r) => r.name);
            for (const table of ['vision_answers', 'vision_compare_samples', 'vision_ui_checks', 'account_data_events', 'telemetry_samples']) {
                assert.ok(names.includes(table), `missing ${table}`);
            }
            assert.ok(!names.includes('vision_outbox'), 'v1 has no public records and no Search outbox');
        });

        await check('an answer cannot claim a bad id, an unknown task or a bad image hash', async () => {
            const db = t.ctx.s.db;
            const sha = 'a'.repeat(64);
            await assert.rejects(db.exec(
                "INSERT INTO vision_answers (id, requester, task, source, image_sha256, image_mime, image_bytes) VALUES ('bad', 'user:usr_x', 'see', 'upload', $1, 'image/png', 10)",
                [sha],
            ), /vision_answers_id|vision_answers_task/);
            await assert.rejects(db.exec(
                "INSERT INTO vision_answers (id, requester, task, source, image_sha256, image_mime, image_bytes) VALUES ($1, 'user:usr_x', 'ask', 'upload', 'nope', 'image/png', 10)",
                [`vis_${ids.ulid()}`],
            ), /vision_answers_sha/);
        });

        await check('a compare sample only names local or ai and a v1 task', async () => {
            const db = t.ctx.s.db;
            const id = `vcm_${ids.ulid()}`;
            await assert.rejects(db.exec("INSERT INTO vision_compare_samples (id, task, engine) VALUES ($1, 'ask', 'cloud')", [id]), /vision_compare_samples_engine/);
            await assert.rejects(db.exec("INSERT INTO vision_compare_samples (id, task, engine) VALUES ($1, 'see', 'ai')", [id]), /vision_compare_samples_task/);
        });

        await check('a UI check keeps findings as jsonb and a valid viewport', async () => {
            const db = t.ctx.s.db;
            const id = `vuc_${ids.ulid()}`;
            await db.exec("INSERT INTO vision_ui_checks (id, requester, source, engine, findings, summary) VALUES ($1, 'anonymous', 'html', 'static-html', '[{\"kind\":\"overflow\"}]'::jsonb, '{}'::jsonb)", [id]);
            const row = await db.maybe('SELECT findings FROM vision_ui_checks WHERE id = $1', [id]);
            assert.strictEqual(row.findings[0].kind, 'overflow');
            await assert.rejects(db.exec("INSERT INTO vision_ui_checks (id, requester, source, engine, viewport_w) VALUES ($1, 'anonymous', 'html', 'static-html', 10)", [`vuc_${ids.ulid()}`]), /vision_ui_checks_viewport/);
        });
    } finally {
        await t.close();
    }
    done();
})();
