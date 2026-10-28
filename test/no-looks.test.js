'use strict';
/**
 * No looks in public AI text: a summary that names looks becomes the title; an answer that names looks is replaced,
 * never repaired word by word; a normal answer survives; and the prompt carries the rule.
 */
const assert = require('assert');
const { cleanAnswer, cleanSummary, hasLooks, SAFE_ANSWER } = require('../server/text/no-looks');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    await check('an answer that names looks is replaced by the neutral sentence', async () => {
        assert.strictEqual(cleanAnswer('A shirtless man in a kitchen laughs.'), SAFE_ANSWER);
        assert.ok(hasLooks('A woman with long blonde hair smiles.'));
        assert.strictEqual(cleanAnswer('A red bicycle leans on a wall.'), 'A red bicycle leans on a wall.');
        assert.strictEqual(cleanSummary('Robot is offline', 'A shirtless man reacts.'), 'Robot is offline');
    });

    const t = await boot();
    try {
        await check('the AI prompt forbids looks and the stored answer is cleaned', async () => {
            t.aiServer.setText('A tall woman in a red dress holds a sign.');
            const user = t.network.addUser('kim');
            const png = await t.textImage('HELLO');
            const r = await t.get('/api/v1/ask', { as: user, multipart: { fields: { task: 'describe', question: 'What is happening?' }, image: png } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().answer.text, SAFE_ANSWER);
            const stored = await t.ctx.s.db.value('SELECT text FROM vision_answers WHERE id = $1', [r.json().answer.id]);
            assert.strictEqual(stored, SAFE_ANSWER);
            const sent = t.aiServer.requests.filter((x) => x.path === '/v1/chat/completions').pop();
            assert.match(JSON.stringify(sent.body), /Never describe a person's body/);
        });
    } finally {
        await t.close();
    }
    done();
})();
