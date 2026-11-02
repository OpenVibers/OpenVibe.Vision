'use strict';

/**
 * Account export and deletion → Vision (ADR-033; openvibe-sdk/account-data). The rows a person owns are their
 * answers, compare samples, UI checks, face consents, encrypted templates/uploads, cast tags and library groups.
 * A general answer keeps no image bytes; the opt-in face rows export their ciphertext, never the server key. A row
 * written by a service token has no subject and is not a person's account data.
 *
 * The database stores bare usr_ ids in the subject columns; an exported file never includes another person's row.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    // F1 familiar-face libraries. Crops and requests go before the people and the library they hang under.
    { table: 'face_library_crops', subject: 'owner', value: (usr) => usr, file: 'face-library-crops.json', erase: 'delete' },
    { table: 'face_consent_requests', subject: 'owner', value: (usr) => usr, file: 'face-consent-requests.json', erase: 'delete' },
    { table: 'face_templates', subject: 'subject', value: (usr) => usr, file: 'face-templates.json', erase: 'delete' },
    { table: 'face_library_people', subject: 'owner', value: (usr) => usr, file: 'face-library-people.json', erase: 'delete' },
    { table: 'face_libraries', subject: 'owner', value: (usr) => usr, file: 'face-libraries.json', erase: 'delete' },
    { table: 'face_tags', subject: 'subject', value: (usr) => usr, file: 'face-tags.json', erase: 'delete' },
    { table: 'face_clusters', subject: 'subject', value: (usr) => usr, file: 'face-clusters.json', erase: 'delete' },
    { table: 'face_media', subject: 'subject', value: (usr) => usr, file: 'face-media.json', erase: 'delete' },
    { table: 'face_consents', subject: 'subject', value: (usr) => usr, file: 'face-consents.json', erase: 'delete' },
    { table: 'vision_private_index', subject: 'owner', value: (usr) => usr, file: 'private-index.json', erase: 'delete' },
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
        note: 'General answers keep no image bytes: an answer holds its cleaned text, a sha256 of the image and model provenance. Face templates and opt-in uploads are exported as AES-GCM ciphertext, never the server key.',
        log,
    });
}

module.exports = { create, TABLES, TOPICS };
