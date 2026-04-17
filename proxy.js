const http = require('http');
const https = require('https');
const fs = require('fs');

let HttpsProxyAgent;
try {
  HttpsProxyAgent = require('https-proxy-agent');
} catch (_) {
  HttpsProxyAgent = null;
}

const BACKEND_URL = process.env.BACKEND_URL || 'https://www.codebuff.com';
const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const OUTBOUND_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';

let API_KEY = fs.readFileSync('/tmp/api_key', 'utf8').trim();
const backendUrl = new URL(BACKEND_URL);

// Build https.Agent with proxy support
function getAgent() {
  if (OUTBOUND_PROXY && HttpsProxyAgent) {
    return new HttpsProxyAgent(OUTBOUND_PROXY);
  }
  return new https.Agent();
}

const agent = getAgent();

// Make request to backend
function backendRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: backendUrl.hostname,
      port: backendUrl.port || 443,
      path,
      method,
      headers,
      agent,
    };

    const req = https.request(options, resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => resolve(data));
  });
}

async function createAgentRun() {
  const body = JSON.stringify({ action: 'START', agentId: 'freebuff-proxy' });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Length': Buffer.byteLength(body),
  };
  const res = await backendRequest('POST', '/api/v1/agent-runs', headers, body);
  const data = await readBody(res);
  const json = JSON.parse(data);
  if (json.runId) return json.runId;
  throw new Error(`No runId: ${data}`);
}

async function finishAgentRun(runId, status) {
  const body = JSON.stringify({ action: 'FINISH', runId, status });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Length': Buffer.byteLength(body),
  };
  try { await backendRequest('POST', '/api/v1/agent-runs', headers, body); } catch (_) {}
}

async function handleRequest(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: OUTBOUND_PROXY || 'direct' }));
    return;
  }

  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'anthropic/claude-sonnet-4', object: 'model', owned_by: 'anthropic' },
        { id: 'anthropic/claude-3.5-sonnet', object: 'model', owned_by: 'anthropic' },
        { id: 'openai/gpt-4o', object: 'model', owned_by: 'openai' },
        { id: 'google/gemini-2.5-pro', object: 'model', owned_by: 'google' },
        { id: 'x-ai/grok-3', object: 'model', owned_by: 'x-ai' },
        { id: 'thudm/glm-5', object: 'model', owned_by: 'thudm' },
      ],
    }));
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
          return;
        }

        let runId;
        try {
          runId = await createAgentRun();
          console.log(`[INFO] Agent run: ${runId}`);
        } catch (e) {
          console.error('[ERROR] createAgentRun:', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Agent run failed: ${e.message}`, type: 'server_error' } }));
          return;
        }

        parsed.codebuff_metadata = parsed.codebuff_metadata || {};
        parsed.codebuff_metadata.run_id = runId;
        parsed.codebuff_metadata.client_id = 'freebuff-proxy';
        parsed.codebuff_metadata.cost_mode = 'free';
        parsed.stream = parsed.stream !== undefined ? parsed.stream : true;

        const newBody = JSON.stringify(parsed);
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'User-Agent': 'ai-sdk/openai-compatible/codebuff',
          'Accept': parsed.stream ? 'text/event-stream' : 'application/json',
          'Content-Length': Buffer.byteLength(newBody),
        };

        try {
          const proxyRes = await backendRequest('POST', '/api/v1/chat/completions', headers, newBody);
          console.log(`[INFO] Backend: ${proxyRes.statusCode}`);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.on('data', (chunk) => { res.write(chunk); });
          proxyRes.on('end', () => {
            res.end();
            finishAgentRun(runId, 'FINISHED').catch(console.error);
          });
        } catch (e) {
          console.error('[ERROR] chat:', e.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
          }
        }
      } catch (e) {
        console.error('[ERROR]', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        }
      }
    });
    return;
  }

  if (req.url.startsWith('/v1/')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const targetPath = req.url.replace('/v1/', '/api/v1/');
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'User-Agent': 'ai-sdk/openai-compatible/codebuff',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      };
      try {
        const proxyRes = await backendRequest(req.method, targetPath, headers, body || undefined);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.on('data', (chunk) => { res.write(chunk); });
        proxyRes.on('end', () => { res.end(); });
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found. Use /v1/chat/completions', type: 'invalid_request_error' } }));
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`[INFO] freebuff-proxy v2024.04.17-6`);
  console.log(`[INFO] Listening on port ${PORT}`);
  console.log(`[INFO] Backend: ${BACKEND_URL}`);
  console.log(`[INFO] Outbound proxy: ${OUTBOUND_PROXY || 'direct'}`);
  console.log(`[INFO] Key: ${API_KEY.substring(0, 8)}...`);
});
