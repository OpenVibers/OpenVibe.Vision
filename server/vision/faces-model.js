'use strict';

// YuNet/SFace ONNX inference runs in this process. No face bytes or vectors reach OpenVibe.AI.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { modelsDir } = require('../paths');

const FILES = Object.freeze({
    yunet: 'face_detection_yunet_2023mar.onnx',
    sface: 'face_recognition_sface_2021dec.onnx',
});
const STRIDES = [8, 16, 32];
const YUNET_INPUT = 640;
const TARGET = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0; let aa = 0; let bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function iou(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x);
    const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y);
    return w * h / (a.width * a.height + b.width * b.height - w * h || 1);
}
function decodeYuNet(outputs, width = YUNET_INPUT, height = YUNET_INPUT, threshold = 0.7) {
    const found = [];
    for (const stride of STRIDES) {
        const cls = outputs[`cls_${stride}`]?.data, obj = outputs[`obj_${stride}`]?.data;
        const box = outputs[`bbox_${stride}`]?.data, kps = outputs[`kps_${stride}`]?.data;
        if (!cls || !obj || !box || !kps) throw new Error('YuNet output shape is unsupported');
        const cols = width / stride, rows = height / stride;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const score = Math.sqrt(Math.max(0, Math.min(1, cls[i])) * Math.max(0, Math.min(1, obj[i])));
            if (score < threshold) continue;
            const cx = (c + box[i * 4]) * stride, cy = (r + box[i * 4 + 1]) * stride;
            const w = Math.exp(box[i * 4 + 2]) * stride, h = Math.exp(box[i * 4 + 3]) * stride;
            if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
            found.push({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, score,
                landmarks: Array.from({ length: 5 }, (_, j) => [(kps[i * 10 + 2 * j] + c) * stride, (kps[i * 10 + 2 * j + 1] + r) * stride]) });
        }
    }
    found.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const f of found.slice(0, 5000)) if (keep.every((k) => iou(f, k) < 0.3)) keep.push(f);
    return keep;
}
function chw(rgb, width, height, bgr = false) {
    const plane = width * height, out = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i++) {
        out[i] = rgb[i * 3 + (bgr ? 2 : 0)];
        out[plane + i] = rgb[i * 3 + 1];
        out[plane * 2 + i] = rgb[i * 3 + (bgr ? 0 : 2)];
    }
    return out;
}
// Least-squares similarity transform, source landmarks → SFace's 112×112 landmark frame.
function alignment(points) {
    const mean = (p, axis) => p.reduce((n, x) => n + x[axis], 0) / p.length;
    const sx = mean(points, 0), sy = mean(points, 1), tx = mean(TARGET, 0), ty = mean(TARGET, 1);
    let a = 0, b = 0, den = 0;
    for (let i = 0; i < 5; i++) {
        const x = points[i][0] - sx, y = points[i][1] - sy;
        const u = TARGET[i][0] - tx, v = TARGET[i][1] - ty;
        a += x * u + y * v; b += x * v - y * u; den += x * x + y * y;
    }
    if (den < 1) throw new Error('face landmarks are degenerate');
    return { a: a / den, b: b / den, sx, sy, tx, ty };
}
function alignedRgb(raw, width, height, points) {
    const { a, b, sx, sy, tx, ty } = alignment(points), den = a * a + b * b;
    const out = Buffer.alloc(112 * 112 * 3);
    for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) {
        const u = x - tx, v = y - ty;
        const px = (a * u + b * v) / den + sx, py = (-b * u + a * v) / den + sy;
        const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
        for (let c = 0; c < 3; c++) {
            const at = (xx, yy) => xx >= 0 && yy >= 0 && xx < width && yy < height ? raw[(yy * width + xx) * 3 + c] : 0;
            out[(y * 112 + x) * 3 + c] = Math.round(at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy);
        }
    }
    return out;
}
function createFacesModel({ dir = modelsDir(), ort = null } = {}) {
    let detectionSession, matchingSession;
    const file = (kind) => path.join(dir, FILES[kind]);
    const available = () => ({ yunet: fs.existsSync(file('yunet')), sface: fs.existsSync(file('sface')) });
    async function session(kind) {
        const runtime = ort || require('onnxruntime-node');
        if (!fs.existsSync(file(kind))) { const e = new Error(`${kind} weights are not installed`); e.code = 'faces.model_unavailable'; throw e; }
        if (kind === 'yunet') return detectionSession ||= await runtime.InferenceSession.create(file(kind), { executionProviders: ['cpu'] });
        return matchingSession ||= await runtime.InferenceSession.create(file(kind), { executionProviders: ['cpu'] });
    }
    async function pixels(buffer) {
        return sharp(buffer, { limitInputPixels: 40_000_000, animated: false }).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    }
    async function detect(buffer) {
        const runtime = ort || require('onnxruntime-node');
        const image = await pixels(buffer);
        const { data } = await sharp(image.data, { raw: image.info }).resize(YUNET_INPUT, YUNET_INPUT, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
        const model = await session('yunet');
        const output = await model.run({ [model.inputNames[0]]: new runtime.Tensor('float32', chw(data, YUNET_INPUT, YUNET_INPUT, true), [1, 3, YUNET_INPUT, YUNET_INPUT]) });
        return decodeYuNet(output).map((f) => ({ ...f,
            x: f.x * image.info.width / YUNET_INPUT, y: f.y * image.info.height / YUNET_INPUT,
            width: f.width * image.info.width / YUNET_INPUT, height: f.height * image.info.height / YUNET_INPUT,
            landmarks: f.landmarks.map(([x, y]) => [x * image.info.width / YUNET_INPUT, y * image.info.height / YUNET_INPUT]),
        }));
    }
    async function embed(buffer, face) {
        const runtime = ort || require('onnxruntime-node');
        const image = await pixels(buffer);
        const aligned = alignedRgb(image.data, image.info.width, image.info.height, face.landmarks);
        const model = await session('sface');
        const out = await model.run({ [model.inputNames[0]]: new runtime.Tensor('float32', chw(aligned, 112, 112), [1, 3, 112, 112]) });
        const vector = Array.from(out[model.outputNames[0]].data);
        if (!vector.length || vector.some((v) => !Number.isFinite(v))) throw new Error('SFace returned an invalid vector');
        return vector;
    }
    async function blur(buffer, faces) {
        const image = await pixels(buffer);
        const base = sharp(image.data, { raw: image.info });
        const layers = [];
        for (const f of faces) {
            const x = Math.max(0, Math.floor(f.x - f.width * 0.12)), y = Math.max(0, Math.floor(f.y - f.height * 0.12));
            const w = Math.min(image.info.width - x, Math.ceil(f.width * 1.24)), h = Math.min(image.info.height - y, Math.ceil(f.height * 1.24));
            if (w < 1 || h < 1) continue;
            const crop = await sharp(image.data, { raw: image.info }).extract({ left: x, top: y, width: w, height: h }).blur(Math.max(8, Math.round(Math.min(w, h) / 8))).png().toBuffer();
            layers.push({ input: crop, left: x, top: y });
        }
        return base.composite(layers).png().toBuffer();
    }
    return { available, detect, embed, blur, cosine };
}
module.exports = { createFacesModel, decodeYuNet, cosine, FILES, YUNET_INPUT };
