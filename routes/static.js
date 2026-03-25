/**
 * Static file serving and screenshot/upload handlers for TAYTERM.
 */

const { sendJson, readBody, parseMultipart } = require('../lib/utils');

module.exports = function createStaticHandler(deps) {
    const { PROJECTS_DIR, STATIC_DIR, BASE_DIR, log, fs, path } = deps;

    function handleIndex(req, res) {
        const indexPath = path.join(STATIC_DIR, 'index.html');
        try {
            let html = fs.readFileSync(indexPath, 'utf-8');
            // Cache bust: replace /static/foo.ext or /static/foo.ext?v=N with /static/foo.ext?v=<mtime>
            html = html.replace(
                /\/static\/([\w.-]+\.(js|css))(\?v=[^"']*)?(["'])/g,
                (match, file, ext, oldV, quote) => {
                    try {
                        const mtime = fs.statSync(path.join(STATIC_DIR, file)).mtimeMs | 0;
                        return `/static/${file}?v=${mtime}${quote}`;
                    } catch (e) { return match; }
                }
            );
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end(html);
        } catch (e) {
            res.writeHead(404);
            res.end('Not found');
        }
    }

    function handleStatic(req, res, filename) {
        const filepath = path.join(STATIC_DIR, filename);
        // Prevent directory traversal
        if (!filepath.startsWith(STATIC_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        try {
            const content = fs.readFileSync(filepath, 'utf-8');
            const ext = path.extname(filename).toLowerCase();
            const contentTypes = {
                '.css': 'text/css',
                '.js': 'application/javascript',
                '.html': 'text/html',
                '.json': 'application/json',
                '.png': 'image/png',
                '.ico': 'image/x-icon',
            };
            const ct = contentTypes[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
            res.end(content);
        } catch (e) {
            res.writeHead(404);
            res.end('Not found');
        }
    }

    async function handleUpload(req, res) {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
            sendJson(res, { error: 'no boundary' }, 400);
            return;
        }
        const boundary = boundaryMatch[1].replace(/;.*$/, '').trim();

        const body = await readBody(req);
        const fields = parseMultipart(body, boundary);

        if (!fields.file || !fields.file.data) {
            sendJson(res, { error: 'no file' }, 400);
            return;
        }

        const project = typeof fields.project === 'string' ? fields.project : null;
        const subfolder = typeof fields.subfolder === 'string' ? fields.subfolder : null;

        let uploadDir;
        if (project) {
            uploadDir = path.join(PROJECTS_DIR, project, '.screenshots');
        } else {
            uploadDir = path.join(PROJECTS_DIR, '.tayterm_uploads');
        }
        if (subfolder) {
            uploadDir = path.join(uploadDir, subfolder);
        }
        fs.mkdirSync(uploadDir, { recursive: true });

        let filename = fields.file.filename || `paste_${Date.now()}.png`;
        filename = path.basename(filename);
        let savePath = path.join(uploadDir, filename);

        if (fs.existsSync(savePath)) {
            const ext = path.extname(filename);
            const base = path.basename(filename, ext);
            filename = `${base}_${Date.now()}${ext}`;
            savePath = path.join(uploadDir, filename);
        }

        fs.writeFileSync(savePath, fields.file.data);
        const size = fs.statSync(savePath).size;
        log(`Upload: ${savePath} (${size} bytes)`);
        const relPath = path.relative(PROJECTS_DIR, savePath).replace(/\\/g, '/');
        const url = '/screenshots/' + encodeURI(relPath);
        sendJson(res, { path: savePath, url });
    }

    function handleScreenshots(req, res, pathname) {
        const relPath = decodeURIComponent(pathname.slice('/screenshots/'.length));
        const filePath = path.join(PROJECTS_DIR, relPath);
        if (fs.existsSync(filePath)) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            res.end(fs.readFileSync(filePath));
        } else {
            res.writeHead(404); res.end('Not found');
        }
    }

    return async function handleStaticRoute(req, res, pathname) {
        if (req.method === 'GET' && pathname === '/') {
            handleIndex(req, res);
            return true;
        }

        if (req.method === 'GET' && pathname.startsWith('/static/')) {
            const filename = pathname.slice('/static/'.length);
            handleStatic(req, res, filename);
            return true;
        }

        if (req.method === 'POST' && pathname === '/upload') {
            await handleUpload(req, res);
            return true;
        }

        if (req.method === 'GET' && pathname.startsWith('/screenshots/')) {
            handleScreenshots(req, res, pathname);
            return true;
        }

        // Not handled
        return false;
    };
};
