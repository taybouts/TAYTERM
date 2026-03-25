/**
 * Shared utilities used across route handlers.
 */

function sendJson(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function parseMultipart(body, boundary) {
    const fields = {};
    const sep = Buffer.from(`--${boundary}`);
    const parts = [];

    // Split by boundary
    let start = 0;
    while (true) {
        const idx = body.indexOf(sep, start);
        if (idx === -1) break;
        if (start > 0) {
            let partData = body.slice(start, idx);
            if (partData[0] === 0x0d && partData[1] === 0x0a) partData = partData.slice(2);
            if (partData[partData.length - 2] === 0x0d && partData[partData.length - 1] === 0x0a) {
                partData = partData.slice(0, partData.length - 2);
            }
            parts.push(partData);
        }
        start = idx + sep.length;
        if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    }

    for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headerStr = part.slice(0, headerEnd).toString('utf-8');
        const partBody = part.slice(headerEnd + 4);

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const fieldName = nameMatch[1];
        const filenameMatch = headerStr.match(/filename="([^"]*)"/);

        if (filenameMatch) {
            fields[fieldName] = { filename: filenameMatch[1], data: partBody };
        } else {
            fields[fieldName] = partBody.toString('utf-8').trim();
        }
    }
    return fields;
}

module.exports = { sendJson, readBody, parseMultipart };
