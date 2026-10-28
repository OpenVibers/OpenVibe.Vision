'use strict';
/** A tiny public-image fixture and a rendered text image for the local OCR and UI checks. */
const http = require('http');
const sharp = require('sharp');

async function textImage(text = 'HELLO VISION', { width = 640, height = 220, background = '#ffffff', color = '#000000' } = {}) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${background}"/><text x="24" y="${Math.round(height * 0.62)}" font-family="DejaVu Sans" font-size="${Math.round(height * 0.38)}" fill="${color}">${String(text).replace(/[<>&]/g, '')}</text></svg>`;
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function startImageServer({ png = null } = {}) {
    const body = png || await textImage('HELLO VISION');
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (req.url === '/image.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length }); return res.end(body); }
        if (req.url === '/redirect') { res.writeHead(302, { Location: '/image.png' }); return res.end(); }
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        png: body,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
    };
}

async function startPageServer({ html = '<!doctype html><html><body><p>ok</p></body></html>' } = {}) {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
        if (req.url === '/redirect') { res.writeHead(302, { Location: '/page' }); return res.end(); }
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
    };
}

module.exports = { textImage, startImageServer, startPageServer };
