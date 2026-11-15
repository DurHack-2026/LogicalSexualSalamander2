'use strict';

const http = require('node:http');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');

function loadEnvironmentFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fsSync.existsSync(envPath)) return;

    const contents = fsSync.readFileSync(envPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;

        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
    }
}

loadEnvironmentFile();

const PORT = Number(process.env.ROOMFIT_PORT || 3000);
const HOST = process.env.ROOMFIT_HOST || '0.0.0.0';
const ACCESS_PASSWORD = process.env.ROOMFIT_PASSWORD || '';
const SHARED_HOST = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const TRELLIS_PORT = Number(process.env.TRELLIS_PORT || 8766);
const TRELLIS_API_URL = process.env.TRELLIS_API_URL || 'http://127.0.0.1:7861';
const AUTO_START_TRELLIS = !['0', 'false', 'no', 'off'].includes(String(process.env.ROOMFIT_AUTOSTART_TRELLIS || '').toLowerCase());
if (!Number.isInteger(TRELLIS_PORT) || TRELLIS_PORT < 1 || TRELLIS_PORT > 65535) {
    throw new Error('TRELLIS_PORT must be a valid TCP port.');
}
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 45000;
const MAX_IKEA_REDIRECTS = 5;
const STATIC_FILES = {
    '/': ['Roomfit.html', 'text/html; charset=utf-8'],
    '/roomfit.html': ['Roomfit.html', 'text/html; charset=utf-8'],
    '/Roomfit.html': ['Roomfit.html', 'text/html; charset=utf-8'],
    '/floorplan.html': ['floorplan.html', 'text/html; charset=utf-8'],
    '/Floorplan.html': ['floorplan.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/roomfit.js': ['roomfit.js', 'text/javascript; charset=utf-8'],
    '/floorplan.js': ['floorplan.js', 'text/javascript; charset=utf-8'],
    '/room-config-storage.js': ['room-config-storage.js', 'text/javascript; charset=utf-8'],
    '/ai_studio_code.js': ['ai_studio_code.js', 'text/javascript; charset=utf-8'],
    '/product-extractor.js': ['product-extractor.js', 'text/javascript; charset=utf-8']
};

function sameSecret(a, b) {
    const left = crypto.createHash('sha256').update(String(a)).digest();
    const right = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(left, right);
}

// When ROOMFIT_PASSWORD is set, every page and API route asks for it once per browser
// (HTTP Basic auth: any username, the password must match).
function isAuthorized(request) {
    if (!ACCESS_PASSWORD) return true;
    const header = request.headers.authorization || '';
    const match = /^Basic\s+(.+)$/i.exec(header);
    if (!match) return false;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0 && sameSecret(decoded.slice(separator + 1), ACCESS_PASSWORD);
}

function networkUrls() {
    const urls = [];
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === 'IPv4' && !address.internal) {
                urls.push('http://' + address.address + ':' + PORT);
            }
        }
    }
    return urls;
}

function sendJson(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}

function startTrellisTunnel() {
    const target = process.env.TRELLIS_SSH_TARGET;
    if (!target) return;
    if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(target)) {
        console.error('TRELLIS_SSH_TARGET must use the user@host format.');
        return;
    }

    const sshPort = Number(process.env.TRELLIS_SSH_PORT || 22);
    const remoteApiPort = Number(process.env.TRELLIS_REMOTE_API_PORT || 7861);
    const identityFile = process.env.TRELLIS_SSH_IDENTITY_FILE;
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535 ||
        !Number.isInteger(remoteApiPort) || remoteApiPort < 1 || remoteApiPort > 65535) {
        console.error('TRELLIS_SSH_PORT and TRELLIS_REMOTE_API_PORT must be valid TCP ports.');
        return;
    }

    let localApiPort;
    try {
        const apiUrl = new URL(TRELLIS_API_URL);
        if (apiUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(apiUrl.hostname)) {
            throw new Error('TRELLIS_API_URL must use a local HTTP address when an SSH tunnel is configured.');
        }
        localApiPort = Number(apiUrl.port || 7861);
    } catch (error) {
        console.error('Could not configure the TRELLIS SSH tunnel:', error.message);
        return;
    }

    const child = spawn('ssh', [
        '-N', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-p', String(sshPort),
        '-L', '127.0.0.1:' + localApiPort + ':127.0.0.1:' + remoteApiPort,
        ...(identityFile ? ['-i', identityFile] : []),
        target
    ], { cwd: __dirname, stdio: 'inherit', env: process.env });

    child.on('error', error => {
        console.error('Could not start the TRELLIS SSH tunnel:', error.message);
    });
    child.on('exit', (code, signal) => {
        if (code === null) {
            console.warn('TRELLIS SSH tunnel exited from signal:', signal);
        } else if (code !== 0) {
            console.warn('TRELLIS SSH tunnel exited with code ' + code + '. Check SSH access and the remote API.');
        }
    });
    console.log('Starting TRELLIS SSH tunnel to ' + target + '.');
}

function startTrellisBridge() {
    if (!AUTO_START_TRELLIS) return;

    const commandCandidates = process.platform === 'win32'
        ? ['py', 'python', 'python3']
        : ['python3', 'python'];

    let command = null;
    let args = ['ai_server_trellis.py'];

    for (const candidate of commandCandidates) {
        const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
        if (!probe.error && probe.status === 0) {
            command = candidate;
            if (candidate === 'py') {
                args = ['-3', 'ai_server_trellis.py'];
            }
            break;
        }
    }

    if (!command) {
        console.warn('Skipping automatic TRELLIS startup because no Python executable was found.');
        return;
    }

    const child = spawn(command, args, {
        cwd: __dirname,
        stdio: 'inherit',
        env: Object.assign({}, process.env, { TRELLIS_API_URL }),
    });

    child.on('error', error => {
        console.error('Could not start ai_server_trellis.py:', error.message);
    });

    child.on('exit', (code, signal) => {
        if (code === null) {
            console.warn('ai_server_trellis.py exited from signal:', signal);
            return;
        }
        if (code !== 0) {
            console.warn('ai_server_trellis.py exited with code ' + code + '. Check the local TRELLIS bridge and tunnel.');
        }
    });

    console.log('Started ai_server_trellis.py automatically.');
}

async function readJson(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            const error = new Error('Request body is too large.');
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
        return value;
    } catch (error) {
        const invalid = new Error('Request body must be a JSON object.');
        invalid.status = 400;
        throw invalid;
    }
}

function checkedHttpUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch (error) {
        const invalid = new Error('Provide a valid absolute product URL.');
        invalid.status = 400;
        throw invalid;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        const invalid = new Error('Only credential-free HTTP and HTTPS product URLs are supported.');
        invalid.status = 400;
        throw invalid;
    }
    return url.href;
}

function isIkeaHostname(hostname) {
    return hostname === 'ikea.com' || hostname.endsWith('.ikea.com');
}

function checkedIkeaUrl(value) {
    const url = new URL(checkedHttpUrl(value));
    if (!isIkeaHostname(url.hostname) || url.port) {
        const invalid = new Error('Only standard-port IKEA product URLs are supported.');
        invalid.status = 400;
        throw invalid;
    }
    return url;
}

async function readResourceBytes(response) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_BYTES) {
        throw new Error('IKEA returned a resource that is too large to process.');
    }
    if (!response.body) return Buffer.alloc(0);

    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_PAGE_BYTES) throw new Error('IKEA returned a resource that is too large to process.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function fetchIkeaResource(value, accept, expectedType) {
    let currentUrl = checkedIkeaUrl(value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
        for (let redirects = 0; redirects <= MAX_IKEA_REDIRECTS; redirects++) {
            let response;
            try {
                response = await fetch(currentUrl.href, {
                    method: 'GET',
                    headers: { 'Accept': accept },
                    redirect: 'manual',
                    signal: controller.signal
                });
            } catch (error) {
                throw new Error(error.name === 'AbortError' ? 'IKEA resource request timed out.' : 'IKEA resource request failed.');
            }

            if ([301, 302, 303, 307, 308].indexOf(response.status) >= 0) {
                const location = response.headers.get('location');
                if (response.body) await response.body.cancel();
                if (!location) throw new Error('IKEA returned a redirect without a location.');
                if (redirects === MAX_IKEA_REDIRECTS) throw new Error('IKEA redirected too many times.');
                currentUrl = checkedIkeaUrl(new URL(location, currentUrl.href).href);
                continue;
            }
            if (!response.ok) throw new Error('IKEA returned HTTP ' + response.status + '.');
            const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (expectedType === 'html' && contentType && !/(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
                throw new Error('IKEA did not return an HTML product page.');
            }
            if (expectedType === 'image' && !/^image\/(png|jpeg|webp|avif|gif)$/.test(contentType)) {
                throw new Error('IKEA did not return a supported product image.');
            }
            const body = await readResourceBytes(response);
            if (!body.length) throw new Error('IKEA returned an empty resource.');
            return { body: body, contentType: contentType || (expectedType === 'html' ? 'text/html' : 'image/jpeg') };
        }
        throw new Error('Could not follow IKEA resource redirects.');
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchIkeaPage(value) {
    const page = await fetchIkeaResource(value, 'text/html,application/xhtml+xml', 'html');
    return { html: page.body.toString('utf8'), markdown: '' };
}

async function fetchIkeaImage(value) {
    return fetchIkeaResource(value, 'image/avif,image/webp,image/png,image/jpeg,image/*', 'image');
}

async function callProvider(endpoint, token, payload, label) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
        let response;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: Object.assign(
                    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    token ? { 'Authorization': 'Bearer ' + token } : {}
                ),
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (error) {
            throw new Error(error.name === 'AbortError' ? label + ' timed out.' : label + ' request failed.');
        }
        if (!response.ok) throw new Error(label + ' returned HTTP ' + response.status + '.');
        const responseText = await response.text();
        try {
            return JSON.parse(responseText);
        } catch (error) {
            const preview = responseText.replace(/\s+/g, ' ').trim().slice(0, 120);
            throw new Error(label + ' returned a non-JSON response' + (preview ? ': ' + preview : '.'));
        }
    } finally {
        clearTimeout(timeout);
    }
}

async function proxyTrellisApi(response, pathname, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
        let upstream;
        try {
            upstream = await fetch('http://127.0.0.1:' + TRELLIS_PORT + pathname, {
                method: payload === undefined ? 'GET' : 'POST',
                headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
                body: payload === undefined ? undefined : JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (error) {
            const unavailable = new Error(error.name === 'AbortError'
                ? 'TRELLIS did not respond before the request timed out.'
                : 'Could not connect to the local TRELLIS service. Start ai_server_trellis.py and check its GPU tunnel.');
            unavailable.status = error.name === 'AbortError' ? 504 : 503;
            throw unavailable;
        }
        response.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        response.end(await upstream.text());
    } finally {
        clearTimeout(timeout);
    }
}

async function handleTrellisApi(request, response, pathname) {
    let targetPath;
    let payload;
    if (request.method === 'GET' && pathname === '/api/trellis/status') {
        targetPath = '/api/status';
    } else if (request.method === 'GET' && pathname === '/api/trellis/models') {
        targetPath = '/api/models';
    } else if (request.method === 'GET') {
        const taskMatch = pathname.match(/^\/api\/trellis\/tasks\/([A-Za-z0-9-]{8,100})$/);
        if (taskMatch) targetPath = '/api/tasks/' + taskMatch[1];
    } else if (request.method === 'POST' && pathname === '/api/trellis/generate') {
        targetPath = '/api/generate';
        payload = await readJson(request);
        payload.name = typeof payload.name === 'string' ? payload.name.slice(0, 120) : '';
        try {
            payload.imageUrl = checkedIkeaUrl(payload.imageUrl).href;
        } catch (error) {
            sendJson(response, error.status || 400, { error: error.message });
            return;
        }
    }
    if (!targetPath) {
        if (pathname === '/api/trellis/generate' || pathname === '/api/trellis/status' ||
            pathname === '/api/trellis/models' || /^\/api\/trellis\/tasks\//.test(pathname)) {
            response.writeHead(405, { 'Allow': pathname === '/api/trellis/generate' ? 'POST' : 'GET' });
            response.end('Method not allowed.');
            return;
        }
        sendJson(response, 404, { error: 'TRELLIS API route not found.' });
        return;
    }
    await proxyTrellisApi(response, targetPath, payload);
}

async function serveGeneratedModel(response, taskId) {
    const filePath = path.join(__dirname, 'generated_trellis_models', taskId + '.glb');
    let stats;
    try {
        stats = await fs.stat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            sendJson(response, 404, { error: 'Generated 3D model not found.' });
            return;
        }
        throw error;
    }
    if (!stats.isFile()) {
        sendJson(response, 404, { error: 'Generated 3D model not found.' });
        return;
    }
    response.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': stats.size,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff'
    });
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', function (error) {
        console.error('Could not stream a generated 3D model.', error);
        response.destroy();
    });
    stream.pipe(response);
}

async function handleApi(request, response, requestUrl) {
    const pathname = requestUrl.pathname;
    const llmUrl = process.env.ROOMFIT_LLM_URL;
    const llmToken = process.env.ROOMFIT_LLM_TOKEN;

    if (pathname.indexOf('/api/trellis/') === 0) {
        await handleTrellisApi(request, response, pathname);
        return;
    }
    if (request.method === 'GET' && pathname === '/api/config') {
        sendJson(response, 200, { pageFetcherConfigured: true, ikeaOnly: true, llmConfigured: Boolean(llmUrl) });
        return;
    }
    if (request.method === 'GET' && pathname === '/api/fetch-image') {
        const image = await fetchIkeaImage(requestUrl.searchParams.get('url'));
        response.writeHead(200, {
            'Content-Type': image.contentType,
            'Cache-Control': 'private, max-age=300',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(image.body);
        return;
    }
    if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
    }

    const body = await readJson(request);
    if (pathname === '/api/fetch-page') {
        sendJson(response, 200, await fetchIkeaPage(body.url));
        return;
    }
    if (pathname === '/api/extract-structured') {
        if (!llmUrl) {
            sendJson(response, 503, { error: 'Structured extraction is not configured on the server.' });
            return;
        }
        const result = await callProvider(llmUrl, llmToken, body, 'Structured extraction provider');
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            sendJson(response, 502, { error: 'Structured extraction provider must return a JSON product object.' });
            return;
        }
        sendJson(response, 200, result);
        return;
    }
    sendJson(response, 404, { error: 'API route not found.' });
}

startTrellisTunnel();
startTrellisBridge();

const server = http.createServer(async (request, response) => {
    let pathname;
    if (!isAuthorized(request)) {
        response.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="Room For Improvement", charset="UTF-8"',
            'Content-Type': 'text/plain; charset=utf-8'
        });
        response.end('Room For Improvement password required.');
        return;
    }
    try {
        const requestUrl = new URL(request.url, 'http://' + request.headers.host);
        pathname = requestUrl.pathname;
        if (pathname.indexOf('/api/') === 0) {
            await handleApi(request, response, requestUrl);
            return;
        }
        const modelMatch = pathname.match(/^\/generated_models\/([A-Za-z0-9-]{8,100})\.glb$/);
        if (modelMatch) {
            if (request.method !== 'GET') {
                response.writeHead(405, { 'Allow': 'GET' });
                response.end('Method not allowed.');
                return;
            }
            await serveGeneratedModel(response, modelMatch[1]);
            return;
        }
        const file = STATIC_FILES[pathname];
        if (!file || request.method !== 'GET') {
            response.writeHead(404);
            response.end('Not found.');
            return;
        }
        const content = await fs.readFile(path.join(__dirname, file[0]));
        response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
        response.end(content);
    } catch (error) {
        if (response.headersSent) {
            response.destroy();
            return;
        }
        if (error.status) {
            sendJson(response, error.status, { error: error.message });
            return;
        }
        console.error('Request failed.');
        sendJson(response, 502, { error: error.message || 'The extraction request failed.' });
    }
});

server.listen(PORT, HOST, () => {
    console.log('Room For Improvement listening on http://127.0.0.1:' + PORT + ' (this computer)');
    if (SHARED_HOST) {
        const urls = networkUrls();
        if (urls.length) {
            console.log('Other devices on the same network can open:');
            urls.forEach(url => console.log('  ' + url));
        }
        if (!ACCESS_PASSWORD) {
            console.warn('Warning: Room For Improvement is reachable by other devices without a password. Set ROOMFIT_PASSWORD in .env to protect your GPU server.');
        }
    } else {
        console.log('Only this computer can open Room For Improvement. Set ROOMFIT_HOST=0.0.0.0 in .env to let other devices use it.');
    }
});
