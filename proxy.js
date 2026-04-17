const http = require('http');
const https = require('https');
const { URL } = require('url');
const net = require('net');
const fs = require('fs');

const BACKEND_URL = process.env.BACKEND_URL || 'https://www.codebuff.com';
const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);

// Outbound proxy support: HTTPS_PROXY / HTTP_PROXY
const OUTBOUND_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';

let API_KEY = fs.readFileSync('/tmp/api_key', 'utf8').trim();

const backendUrl = new URL(BACKEND_URL);

// Build request options, with or without outbound proxy
function buildOptions(method, path, headers, useProxy) {
  const opts = {
    method,
    headers: { ...headers },
  };

  if (useProxy && OUTBOUND_PROXY) {
    const proxyUrl = new URL(OUTBOUND_PROXY);
    opts.hostname = proxyUrl.hostname;
    opts.port = proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80);
    opts.path = `${backendUrl.protocol}//${backendUrl.hostname}${path}`;
    opts.headers.Host = backendUrl.hostname;

    // Auth for proxy
    if (proxyUrl.username || proxyUrl.password) {
      const auth = Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString('base64');
      opts.headers['Proxy-Authorization'] = `Basic ${auth}`;
    }

    // CONNECT tunnel for HTTPS through HTTP proxy
    if (backendUrl.protocol === 'https:') {
      opts.agent = createTunnelAgent(proxyUrl, backendUrl.hostname, 443);
    }
  } else {
    opts.hostname = backendUrl.hostname;
    opts.port = backendUrl.port || (backendUrl.protocol === 'https:' ? 443 : 80);
    opts.path = path;
  }

  return opts;
}

// Create HTTPS CONNECT tunnel through HTTP proxy
function createTunnelAgent(proxyUrl, targetHost, targetPort) {
  return new https.Agent({
    createConnection: (options, callback) => {
      const proxyPort = parseInt(proxyUrl.port || '7890', 10);
      const proxyHost = proxyUrl.hostname;

      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers: {
          Host: `${targetHost}:${targetPort}`,
        },
      });

      if (proxyUrl.username || proxyUrl.password) {
        const auth = Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString('base64');
        connectReq.setHeader('Proxy-Authorization', `Basic ${auth}`);
      }

      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          callback(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
          return;
        }

        const tlsSocket = tls.connect({
          socket,
          servername: targetHost,
        }, () => {
          callback(null, tlsSocket);
        });

        tlsSocket.on('error', (e) => callback(e));
      });

      connectReq.on('error', (e) => callback(e));
      connectReq.end();
    },
  });
}

const tls = require('tls');

// Make outbound request with proxy support
function makeRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = buildOptions(method, path, headers, true);
    const isHttps = backendUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Make outbound request with streaming response
function makeStreamingRequest(method, path, headers, body, onResponse) {
  return new Promise((resolve, reject) => {
    const opts = buildOptions(method, path, headers, true);
    const isHttps = backendUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    const req = mod.request(opts, (proxyRes) => {
      onResponse(proxyRes);
      proxyRes.on('end', () => resolve());
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Create agent run
async function createAgentRun() {
  const body = JSON.stringify({ action: 'START', agentId: 'freebuff-proxy' });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Length': Buffer.byteLength(body),
  };

  const res = await makeRequest('POST', '/api/v1/agent-runs', headers, body);
  const json = JSON.parse(res.body);

  if (json.runId) return json.runId;
  throw new Error(`No runId: ${res.body}`);
}

// Finish agent run
async function finishAgentRun(runId, status) {
  const body = JSON.stringify({ action: 'FINISH', runId, status });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Length': Buffer.byteLength(body),
  };
  try { await makeRequest('POST', '/api/v1/agent-runs', headers, body); } catch (_) {}
}

// Main request handler
async function handleRequest(req, res) {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: OUTBOUND_PROXY || 'direct' }));
    return;
  }

  // Models list
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

  // Chat completions
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

        // Create agent run
        let runId;
        try {
          runId = await createAgentRun();
        } catch (e) {
          console.error('[ERROR] createAgentRun:', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Agent run failed: ${e.message}`, type: 'server_error' } }));
          return;
        }

        // Inject codebuff_metadata
        parsed.codebuff_metadata = parsed.codebuff_metadata || {};
        parsed.codebuff_metadata.run_id = runId;
        parsed.codebuff_metadata.client_id = parsed.codebuff_metadata.client_id || 'freebuff-proxy';
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

        // Stream or non-stream
        try {
          await makeStreamingRequest('POST', '/api/v1/chat/completions', headers, newBody, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.on('data', (chunk) => { res.write(chunk); });
            proxyRes.on('end', () => {
              res.end();
              finishAgentRun(runId, 'FINISHED').catch(console.error);
            });
          });
        } catch (e) {
          console.error('[ERROR] chat completions:', e.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
          }
        }
      } catch (e) {
        console.error('[ERROR] Internal:', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        }
      }
    });
    return;
  }

  // All other /v1/ paths
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
        const result = await makeRequest(req.method, targetPath, headers, body || undefined);
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
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
  console.log(`[INFO] freebuff-proxy v2024.04.17-4`);
  console.log(`[INFO] Listening on port ${PORT}`);
  console.log(`[INFO] Backend: ${BACKEND_URL}`);
  console.log(`[INFO] Outbound proxy: ${OUTBOUND_PROXY || 'direct'}`);
  console.log(`[INFO] Key: ${API_KEY.substring(0, 8)}...`);
});
