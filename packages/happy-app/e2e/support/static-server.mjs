// Dependency-free static file server with SPA fallback, for serving the
// `expo export` web build during Playwright E2E. Cross-platform (Node only).
// Usage: node e2e/support/static-server.mjs <dir> <port>
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const dir = process.argv[2] || 'dist-e2e';
const port = Number(process.argv[3] || 8099);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

async function tryFile(p) {
    try {
        const s = await stat(p);
        if (s.isFile()) return p;
    } catch {}
    return null;
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${port}`);
        let pathname = decodeURIComponent(url.pathname);
        // Prevent path traversal.
        const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
        let filePath = join(dir, rel);

        let resolved = await tryFile(filePath);
        if (!resolved && pathname !== '/' && !extname(pathname)) {
            resolved = await tryFile(join(filePath, 'index.html'));
        }
        // SPA fallback: any unknown non-asset route -> index.html (client routing).
        if (!resolved) resolved = join(dir, 'index.html');

        const body = await readFile(resolved);
        const type = MIME[extname(resolved)] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
    } catch (e) {
        res.writeHead(500);
        res.end('static-server error');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`static-server: serving ${dir} on http://127.0.0.1:${port}`);
});
