'use strict';

/**
 * Account export and deletion → Vision (ADR-033; openvibe-sdk/account-data). The rows a person owns are their
 * answers, their compare samples and their UI checks. The local OCR text is part of the answer; image bytes are
 * never stored, so there is nothing else to erase. A row written by a service token has no subject and is not a
 * person's account data.
 *
 * The database stores bare usr_ ids in the subject columns; an exported file never includes another person's row.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    // Compare samples before their answer, so the deletion counts them itself rather than through the FK cascade.
    { table: 'vision_compare_samples', subject: 'subject', value: (usr) => usr, file: 'compare.json', erase: 'delete' },
    { table: 'vision_answers', subject: 'subject', value: (usr) => usr, file: 'answers.json', erase: 'delete' },
    { table: 'vision_ui_checks', subject: 'subject', value: (usr) => usr, file: 'ui-checks.json', erase: 'delete' },
];

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'vision',
        tables: TABLES,
        note: 'Image bytes are never stored: an answer holds its cleaned text, a sha256 of the image and model provenance.',
        log,
    });
}

module.exports = { create, TABLES, TOPICS };
