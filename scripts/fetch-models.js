#!/usr/bin/env node
'use strict';
// Explicit operator action: no model downloads occur in requests or tests.
const fs = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const root = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'models');
const models = [
    { dir: 'clip', repo: 'Xenova/clip-vit-base-patch32', revision: '6b7c523703ae26e39be4b03774966f8571c7f523', files: ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt', 'onnx/text_model_quantized.onnx', 'onnx/vision_model_quantized.onnx'] },
    { dir: 'detr', repo: 'Xenova/detr-resnet-50', revision: '8be7ab59ff663484ee9ba2e8d8f267330d5ad03e', files: ['config.json', 'preprocessor_config.json', 'onnx/model_quantized.onnx'] },
];
(async () => {
    for (const model of models) for (const file of model.files) {
        const target = path.join(root, model.dir, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        try { if ((await fs.stat(target)).size > 0) continue; } catch { /* fetch */ }
        const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
        const response = await fetch(url);
        if (!response.ok || !response.body) throw new Error(`model fetch failed: ${model.repo}/${file} (${response.status})`);
        const temp = `${target}.partial`;
        try { await pipeline(Readable.fromWeb(response.body), require('fs').createWriteStream(temp)); await fs.rename(temp, target); }
        finally { await fs.rm(temp, { force: true }); }
        process.stdout.write(`fetched ${model.dir}/${file}\n`);
    }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
