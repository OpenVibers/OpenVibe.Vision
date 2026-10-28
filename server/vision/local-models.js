'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { VisionError } = require('./service');

function unit(data) {
    const v = Array.from(data, Number);
    const norm = Math.hypot(...v);
    if (!norm || !v.every(Number.isFinite)) throw new VisionError(503, 'vision.model_failed', 'the local model returned an invalid embedding');
    return v.map((x) => x / norm);
}
function cosine(a, b) { return a.length === b.length ? a.reduce((n, x, i) => n + x * b[i], 0) : -1; }
function createLocalModels({ config, clip: fakeClip, detector: fakeDetector } = {}) {
    const root = path.resolve(config.models.dir);
    const clipDir = path.join(root, 'clip');
    const detectorDir = path.join(root, 'detr');
    let clipPromise; let detectorPromise;
    const clipReady = () => Boolean(fakeClip || (fs.existsSync(path.join(clipDir, 'onnx/text_model_quantized.onnx')) && fs.existsSync(path.join(clipDir, 'onnx/vision_model_quantized.onnx'))));
    const detectorReady = () => Boolean(fakeDetector || fs.existsSync(path.join(detectorDir, 'onnx/model_quantized.onnx')));
    async function clip() {
        if (fakeClip) return fakeClip;
        if (!clipReady()) throw new VisionError(503, 'vision.clip_unavailable', 'local CLIP weights are missing; run npm run models:fetch');
        if (!clipPromise) clipPromise = (async () => {
            const { env, AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage } = await import('@huggingface/transformers');
            env.allowRemoteModels = false;
            const opts = { local_files_only: true, dtype: 'q8' };
            const [tokenizer, processor, textModel, visionModel] = await Promise.all([
                AutoTokenizer.from_pretrained(clipDir, opts), AutoProcessor.from_pretrained(clipDir, opts),
                CLIPTextModelWithProjection.from_pretrained(clipDir, opts), CLIPVisionModelWithProjection.from_pretrained(clipDir, opts),
            ]);
            return {
                async text(q) { return unit((await textModel(await tokenizer(q, { padding: true, truncation: true }))).text_embeds.data); },
                async image(buffer) { const img = await RawImage.read(new Blob([buffer])); return unit((await visionModel(await processor(img))).image_embeds.data); },
            };
        })().catch((e) => { clipPromise = null; throw new VisionError(503, 'vision.clip_unavailable', `local CLIP could not load: ${e.message}`); });
        return clipPromise;
    }
    async function detect(buffer) {
        if (fakeDetector) return fakeDetector.detect(buffer);
        if (!detectorReady()) throw new VisionError(503, 'vision.detector_unavailable', 'local detector weights are missing; run npm run models:fetch');
        if (!detectorPromise) detectorPromise = (async () => {
            const { env, pipeline } = await import('@huggingface/transformers');
            env.allowRemoteModels = false;
            return pipeline('object-detection', detectorDir, { local_files_only: true, dtype: 'q8' });
        })().catch((e) => { detectorPromise = null; throw new VisionError(503, 'vision.detector_unavailable', `local detector could not load: ${e.message}`); });
        return (await detectorPromise)(new Blob([buffer]), { threshold: 0.3 });
    }
    async function histogram(buffer) {
        const { data } = await sharp(buffer).rotate().resize(32, 32, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const h = new Array(48).fill(0);
        for (let i = 0; i < data.length; i += 3) for (let c = 0; c < 3; c++) h[c * 16 + Math.min(15, Math.floor(data[i + c] / 16))]++;
        return h.map((n) => n / 3072);
    }
    function histogramDistance(a, b) { return a.reduce((n, x, i) => n + Math.abs(x - b[i]), 0) / 6; }
    return { clip, detect, clipReady, detectorReady, histogram, histogramDistance, cosine };
}
module.exports = { createLocalModels, cosine, unit };
