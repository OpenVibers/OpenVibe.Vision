'use strict';

/**
 * Vision's rows: one answer (ask/describe/OCR/compare), the compare samples that answer produced, and one UI
 * check. Image bytes are never here. A row with a subject is the person's and is exported/erased with their
 * account; a row from a service token has no subject.
 *
 * GET /api/v1/benchmarks aggregates these rows without subjects: per provider/model, task, samples, successful
 * answers, mean latency and mean cost. v1 keeps the measurements; the public Arena leaderboards are v2.
 */
const { wireReview, wireReport, wireReveal } = require('./vision/review');

const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function wireAnswer(row) {
    if (!row) return null;
    let answer = row.answer;
    if (typeof answer === 'string') { try { answer = JSON.parse(answer); } catch { answer = {}; } }
    return {
        id: row.id,
        task: row.task,
        question: row.question == null ? null : row.question,
        mode: row.mode,
        source: row.source,
        source_url: row.source_url == null ? null : row.source_url,
        image_sha256: row.image_sha256,
        image_mime: row.image_mime,
        image_bytes: Number(row.image_bytes) || 0,
        text: row.text == null ? null : row.text,
        answer: answer && typeof answer === 'object' ? answer : {},
        model: row.model == null ? null : row.model,
        provider: row.provider == null ? null : row.provider,
        route: row.route == null ? null : row.route,
        reason: row.reason == null ? null : row.reason,
        cost_usd: num(row.cost_usd),
        latency_ms: Number(row.latency_ms) || 0,
        created_at: iso(row.created_at),
    };
}

function wireSample(row) {
    if (!row) return null;
    return {
        engine: row.engine,
        requested_model: row.requested_model == null ? null : row.requested_model,
        model: row.model == null ? null : row.model,
        provider: row.provider == null ? null : row.provider,
        route: row.route == null ? null : row.route,
        ok: Boolean(row.ok),
        text: row.text == null ? null : row.text,
        cost_usd: num(row.cost_usd),
        latency_ms: Number(row.latency_ms) || 0,
        error_code: row.error_code == null ? null : row.error_code,
    };
}

function wireUiCheck(row) {
    if (!row) return null;
    let findings = row.findings; let summary = row.summary;
    if (typeof findings === 'string') { try { findings = JSON.parse(findings); } catch { findings = []; } }
    if (typeof summary === 'string') { try { summary = JSON.parse(summary); } catch { summary = {}; } }
    return {
        id: row.id,
        source: row.source,
        url: row.url == null ? null : row.url,
        image_sha256: row.image_sha256 == null ? null : row.image_sha256,
        viewport: { w: Number(row.viewport_w) || 1280, h: Number(row.viewport_h) || 800 },
        engine: row.engine,
        findings: Array.isArray(findings) ? findings : [],
        summary: summary && typeof summary === 'object' ? summary : {},
        created_at: iso(row.created_at),
    };
}

function createStore(s) {
    const db = s.db;

    async function saveAnswer({ subject = null, requester, task, question = null, mode = 'auto', image, text = null, answer = {}, model = null, provider = null, route = null, reason = null, costUsd = 0, latencyMs = 0 }) {
        const id = s.newId('vis');
        const row = await db.maybe(
            `INSERT INTO vision_answers (id, subject, requester, task, question, mode, source, source_url, image_sha256, image_mime, image_bytes,
                text, answer, model, provider, route, reason, cost_usd, latency_ms, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, now()) RETURNING *`,
            [id, subject, requester, task, question, mode, image.source, image.sourceUrl || null, image.sha256, image.mime, image.bytes,
                text == null ? null : String(text).slice(0, 20000), JSON.stringify(answer || {}), model, provider, route, reason, Math.max(0, Number(costUsd) || 0), Math.max(0, Math.round(Number(latencyMs) || 0))],
        );
        return wireAnswer(row);
    }

    async function answerById(id) {
        return wireAnswer(await db.maybe('SELECT * FROM vision_answers WHERE id = $1', [String(id || '')]));
    }

    /** Ownership is checked from the row, never from a value the API returns. */
    async function answerSubject(id) {
        const row = await db.maybe('SELECT subject FROM vision_answers WHERE id = $1', [String(id || '')]);
        return row ? row.subject : null;
    }

    async function listAnswers({ subject = null, requester = null, limit = 20 } = {}) {
        const n = Math.min(50, Math.max(1, Number(limit) || 20));
        const args = []; const where = [];
        if (subject) { args.push(subject); where.push(`subject = $${args.length}`); }
        if (requester) { args.push(requester); where.push(`requester = $${args.length}`); }
        args.push(n);
        const rows = await db.many(`SELECT * FROM vision_answers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args);
        return rows.map(wireAnswer);
    }

    async function saveCompare({ subject = null, requester, task = 'ask', image, question = null, samples = [] }) {
        return await s.tx(async (t) => {
            const answerId = s.newId('vis');
            const rows = (Array.isArray(samples) ? samples : []).slice(0, 8).map((x) => ({
                engine: x.engine === 'local' ? 'local' : 'ai',
                requested_model: x.requestedModel == null ? null : String(x.requestedModel).slice(0, 120),
                model: x.model == null ? null : String(x.model).slice(0, 120),
                provider: x.provider == null ? null : String(x.provider).slice(0, 80),
                route: x.route == null ? null : String(x.route).slice(0, 80),
                ok: Boolean(x.ok),
                text: x.text == null ? null : String(x.text).slice(0, 20000),
                costUsd: Math.max(0, Number(x.costUsd) || 0),
                latencyMs: Math.max(0, Math.round(Number(x.ms) || 0)),
                errorCode: x.errorCode == null ? null : String(x.errorCode).slice(0, 80),
            }));
            const best = rows.filter((x) => x.ok).sort((a, b) => a.costUsd - b.costUsd || a.latencyMs - b.latencyMs)[0] || null;
            const text = best ? best.text : null;
            const answerRow = await t.maybe(
                `INSERT INTO vision_answers (id, subject, requester, task, question, mode, source, source_url, image_sha256, image_mime, image_bytes,
                    text, answer, model, provider, route, reason, cost_usd, latency_ms, created_at)
                 VALUES ($1, $2, $3, $4, $5, 'auto', $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, now()) RETURNING *`,
                [answerId, subject, requester, task, question, image.source, image.sourceUrl || null, image.sha256, image.mime, image.bytes,
                    text == null ? null : String(text).slice(0, 20000), JSON.stringify({ samples: rows }), best && best.model, best && best.provider, best && best.route,
                    best ? 'cheapest successful engine in this compare' : 'no engine answered', best ? best.costUsd : 0, best ? best.latencyMs : 0],
            );
            for (const x of rows) {
                await t.exec(
                    `INSERT INTO vision_compare_samples (id, answer_id, subject, task, engine, requested_model, model, provider, route, ok, text, cost_usd, latency_ms, error_code, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())`,
                    [s.newId('vcm'), answerId, subject, ['ask', 'describe', 'ocr', 'translate', 'identify', 'count'].includes(task) ? task : 'ask',
                        x.engine, x.requested_model, x.model, x.provider, x.route, x.ok, x.text, x.costUsd, x.latencyMs, x.errorCode],
                );
            }
            return { answer: wireAnswer(answerRow), samples: rows.map((x) => ({ engine: x.engine, requested_model: x.requested_model, model: x.model, provider: x.provider, route: x.route, ok: x.ok, text: x.text, cost_usd: x.costUsd, latency_ms: x.latencyMs, error_code: x.errorCode })) };
        });
    }

    async function saveUiCheck({ subject = null, requester, source, url = null, imageSha256 = null, viewport, engine, findings, summary }) {
        const id = s.newId('vuc');
        const row = await db.maybe(
            `INSERT INTO vision_ui_checks (id, subject, requester, source, url, image_sha256, viewport_w, viewport_h, engine, findings, summary, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, now()) RETURNING *`,
            [id, subject, requester, source, url, imageSha256, Math.max(160, Number(viewport && viewport.w) || 1280), Math.max(160, Number(viewport && viewport.h) || 800), engine, JSON.stringify(findings || []), JSON.stringify(summary || {})],
        );
        return wireUiCheck(row);
    }

    async function uiCheckById(id) {
        return wireUiCheck(await db.maybe('SELECT * FROM vision_ui_checks WHERE id = $1', [String(id || '')]));
    }

    async function uiCheckSubject(id) {
        const row = await db.maybe('SELECT subject FROM vision_ui_checks WHERE id = $1', [String(id || '')]);
        return row ? row.subject : null;
    }

    /** Aggregate only: no subject, no image, no answer text. Enough for the v1 first proof and the v2 Arena. */
    async function benchmarks({ task = null, limit = 50 } = {}) {
        const n = Math.min(100, Math.max(1, Number(limit) || 50));
        const args = []; let where = "ok = true AND model IS NOT NULL";
        if (task) { args.push(String(task)); where += ` AND task = $${args.length}`; }
        args.push(n);
        const rows = await db.many(
            `SELECT task, engine, provider, model, COUNT(*)::int AS samples,
                    ROUND(AVG(latency_ms))::int AS avg_latency_ms, ROUND(AVG(cost_usd)::numeric, 6) AS avg_cost_usd,
                    ROUND(MIN(cost_usd)::numeric, 6) AS min_cost_usd, ROUND(MAX(latency_ms))::int AS max_latency_ms
             FROM vision_compare_samples WHERE ${where}
             GROUP BY task, engine, provider, model ORDER BY avg_cost_usd ASC, avg_latency_ms ASC LIMIT $${args.length}`,
            args,
        );
        return rows.map((r) => ({
            task: r.task, engine: r.engine, provider: r.provider, model: r.model, samples: Number(r.samples) || 0,
            avg_latency_ms: Number(r.avg_latency_ms) || 0, avg_cost_usd: num(r.avg_cost_usd),
            min_cost_usd: num(r.min_cost_usd), max_latency_ms: Number(r.max_latency_ms) || 0,
        }));
    }

    // ── Unsafe-image reviews (VIS-6) ─────────────────────────
    async function saveReview({ subject = null, requester, objectType = 'unknown', objectId = null, objectApp = null, ownerSubject = null, mediaObjectId = null, mediaApp = null,
        imageSha256 = null, imageMime = null, imageBytes = null, previewUrl = null, category, plainWords, action,
        public: isPublic = false, reason = null, cue = null, engine, model = null, provider = null, route = null,
        confidence = null, costUsd = 0, latencyMs = 0 }) {
        const id = s.newId('vir');
        const row = await db.maybe(
            `INSERT INTO vision_image_reviews (id, subject, requester, object_type, object_id, object_app, owner_subject, image_sha256,
                image_mime, image_bytes, preview_url, category, plain_words, action, is_public, reason, cue, engine, model,
                provider, route, confidence, cost_usd, latency_ms, media_object_id, media_app, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,now()) RETURNING *`,
            [id, subject, requester, String(objectType).slice(0, 80), objectId == null ? null : String(objectId).slice(0, 300), objectApp,
                ownerSubject, imageSha256, imageMime, imageBytes, previewUrl, category, plainWords, action, Boolean(isPublic), reason,
                cue, engine, model, provider, route, confidence == null ? null : Math.max(0, Math.min(1, Number(confidence) || 0)),
                Math.max(0, Number(costUsd) || 0), Math.max(0, Math.round(Number(latencyMs) || 0)), mediaObjectId, mediaApp],
        );
        return wireReview(row);
    }

    async function reviewById(id) {
        return wireReview(await db.maybe('SELECT * FROM vision_image_reviews WHERE id = $1', [String(id || '')]));
    }

    async function reviewWithReport(id) {
        const row = await db.maybe('SELECT * FROM vision_image_reviews WHERE id = $1', [String(id || '')]);
        if (!row) return null;
        const report = await operatorReportFor(row.id);
        const reveals = await listReviewReveals(row.id);
        return wireReview({ ...row, report, reveals });
    }

    async function listReviews({ category = null, status = null, limit = 50 } = {}) {
        const n = Math.min(200, Math.max(1, Number(limit) || 50));
        const args = []; const where = [];
        if (category) { args.push(String(category)); where.push(`category = $${args.length}`); }
        if (status) { args.push(String(status)); where.push(`status = $${args.length}`); }
        args.push(n);
        const rows = await db.many(`SELECT * FROM vision_image_reviews ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args);
        const reportIds = rows.filter((r) => r.category === 'minor_sexual').map((r) => r.id);
        const reports = reportIds.length ? await db.many('SELECT * FROM vision_operator_reports WHERE review_id = ANY($1::text[])', [reportIds]) : [];
        const byReview = new Map(reports.map((r) => [r.review_id, r]));
        return rows.map((r) => wireReview({ ...r, report: byReview.get(r.id) || null }));
    }

    async function reviewCounts() {
        const rows = await db.many('SELECT category, COUNT(*)::int AS n FROM vision_image_reviews GROUP BY category');
        const out = { fine: 0, sex_acts: 0, minor_sexual: 0, total: 0 };
        for (const r of rows) { if (out[r.category] != null) out[r.category] = Number(r.n) || 0; out.total += Number(r.n) || 0; }
        const open = await db.maybe("SELECT COUNT(*)::int AS n FROM vision_operator_reports WHERE status = 'open'");
        out.reports_open = Number(open && open.n) || 0;
        return out;
    }

    async function decideReview(id, { category, plainWords, action, public: isPublic, reviewedBy }) {
        return wireReview(await db.maybe(
            `UPDATE vision_image_reviews SET category = $2, plain_words = $3, action = $4, is_public = $5,
                status = 'decided', reviewed_by = $6, reviewed_at = now() WHERE id = $1 RETURNING *`,
            [String(id), category, plainWords, action, Boolean(isPublic), reviewedBy],
        ));
    }

    async function createOperatorReport({ reviewId, category = 'minor_sexual', objectType = 'unknown', objectId = null, ownerSubject = null, reason = null }) {
        const id = s.newId('vor');
        const row = await db.maybe(
            `INSERT INTO vision_operator_reports (id, review_id, category, object_type, object_id, owner_subject, reason, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT (review_id) DO NOTHING RETURNING *`,
            [id, String(reviewId), category, String(objectType).slice(0, 80), objectId == null ? null : String(objectId).slice(0, 300), ownerSubject, reason],
        );
        return wireReport(row || await db.maybe('SELECT * FROM vision_operator_reports WHERE review_id = $1', [String(reviewId)]));
    }

    async function operatorReportFor(reviewId) {
        return wireReport(await db.maybe('SELECT * FROM vision_operator_reports WHERE review_id = $1', [String(reviewId || '')]));
    }

    async function listOperatorReports({ status = 'open', limit = 50 } = {}) {
        const n = Math.min(200, Math.max(1, Number(limit) || 50));
        const args = []; const where = [];
        if (status) { args.push(String(status)); where.push(`r.status = $${args.length}`); }
        args.push(n);
        const rows = await db.many(`SELECT r.* FROM vision_operator_reports r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT $${args.length}`, args);
        return rows.map(wireReport);
    }

    async function saveReviewReveal({ reviewId, operatorSubject, kind, expiresAt = null }) {
        const id = s.newId('virv');
        return wireReveal(await db.maybe(
            `INSERT INTO vision_review_reveals (id, review_id, operator_subject, kind, expires_at, revealed_at)
             VALUES ($1,$2,$3,$4,$5::timestamptz,now()) RETURNING *`,
            [id, String(reviewId), operatorSubject, kind, expiresAt],
        ));
    }

    async function listReviewReveals(reviewId) {
        const rows = await db.many('SELECT * FROM vision_review_reveals WHERE review_id = $1 ORDER BY revealed_at DESC, id DESC LIMIT 50', [String(reviewId || '')]);
        return rows.map(wireReveal);
    }

    async function dismissOperatorReport(reviewId, by) {
        return wireReport(await db.maybe(
            `UPDATE vision_operator_reports SET status = 'dismissed', resolved_at = now(), resolved_by = $2
             WHERE review_id = $1 AND status = 'open' RETURNING *`,
            [String(reviewId), String(by || 'operator')],
        ));
    }

    return { saveAnswer, answerById, answerSubject, listAnswers, saveCompare, saveUiCheck, uiCheckById, uiCheckSubject, benchmarks,
        saveReview, reviewById, reviewWithReport, listReviews, reviewCounts, decideReview, createOperatorReport,
        operatorReportFor, listOperatorReports, dismissOperatorReport, saveReviewReveal, listReviewReveals };
}

module.exports = { createStore, wireAnswer, wireSample, wireUiCheck };
