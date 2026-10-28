'use strict';

/**
 * OpenVibe.Vision's own PostgreSQL database (ADR-035): the schema is migrations/NNNN_*.sql, applied at boot.
 * A general answer stores the cleaned text, a sha256 of the image and the model provenance, never the image bytes,
 * a token or a provider key. The opt-in face tables hold encrypted templates/uploads and consent records, never the
 * AES key.
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { ids } = require('openvibe-contracts');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data/add-service.sh today)');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[OpenVibe.Vision] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'vision', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'vision-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'vision', registry, log });
}

/** The store every module takes: the db handle, a clock (epoch ms; tests inject one), ids and transactions. */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        iso: () => new Date(now()).toISOString(),
        newId: (prefix) => `${prefix}_${ids.ulid(now())}`,
        tx: async (fn) => await db.tx((t) => fn(t)),
        close: () => db.close(),
    };
}

async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

module.exports = { openDb, openStore, createStore, MIGRATIONS };
