'use strict';
const path = require('path');

// One host-owned data root; model weights are never part of the repository.
function dataDir(env = process.env) {
    return path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
}
function modelsDir(env = process.env) { return path.join(dataDir(env), 'models'); }
module.exports = { dataDir, modelsDir };
