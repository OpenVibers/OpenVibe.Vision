'use strict';
// Pinned OpenCV Zoo assets. Download to a temporary file, verify SHA-256, then rename into DATA_DIR/models.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { modelsDir } = require('../server/paths');

const MODELS = Object.freeze([
    {
        name: 'face_detection_yunet_2023mar.onnx',
        url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
        sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    },
    {
        name: 'face_recognition_sface_2021dec.onnx',
        url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
        sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    },
]);
async function digest(file) {
    const h = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) h.update(chunk);
    return h.digest('hex');
}
async function download(model, dir = modelsDir()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, model.name);
    if (fs.existsSync(target) && await digest(target) === model.sha256) return target;
    const temp = path.join(dir, `.${model.name}.${process.pid}.tmp`);
    try {
        const response = await fetch(model.url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`${model.name}: download failed (${response.status})`);
        const file = fs.createWriteStream(temp, { mode: 0o600 });
        for await (const chunk of response.body) {
            if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve));
        }
        await new Promise((resolve, reject) => file.end((err) => err ? reject(err) : resolve()));
        if (await digest(temp) !== model.sha256) throw new Error(`${model.name}: sha256 mismatch`);
        fs.renameSync(temp, target);
        return target;
    } finally { fs.rmSync(temp, { force: true }); }
}
if (require.main === module) Promise.all(MODELS.map((m) => download(m))).then((paths) => {
    for (const file of paths) process.stdout.write(`verified ${file}\n`);
}).catch((err) => { console.error(err.message); process.exitCode = 1; });
module.exports = { MODELS, download, digest };
