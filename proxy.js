const http = require('http');
const https = require('https');

const BACKEND_URL = process.env.BACKEND_URL || 'https://www.codebuff.com';
const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const fs = require('fs');

// Read API key from file (set by entrypoint.sh)
let API_KEY = fs.readFileSync('/tmp/api_key', 'utf8').trim();

const backendUrl = new URL(BACKEND_URL);
const httpModule = backendUrl.protocol === 'https:' ? https : http;

// Create an agent run and return runId
function createAgentRun(apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      action: 'START',
      agentId: 'freebuff-proxy',
    });

    const options = {
      hostname: backendUrl.hostname,
      port: backendUrl.port || 443,
      path: '/api/v1/agent-runs',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.runId) {
            resolve(json.runId);
          } else {
            reject(new Error(`No runId in response: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse agent-runs response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Forward request to codebuff backend, injecting auth and runId
async function handleRequest(req, res) {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
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
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
          return;
        }

        // Create agent run for runId
        let runId;
        try {
          runId = await createAgentRun(API_KEY);
        } catch (e) {
          console.error('[ERROR] Failed to create agent run:', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Failed to create agent run: ${e.message}`, type: 'server_error' } }));
          return;
        }

        // Inject codebuff_metadata with runId
        parsed.codebuff_metadata = parsed.codebuff_metadata || {};
        parsed.codebuff_metadata.run_id = runId;
        parsed.codebuff_metadata.client_id = parsed.codebuff_metadata.client_id || 'freebuff-proxy';
        parsed.codebuff_metadata.cost_mode = 'free';
        parsed.stream = parsed.stream !== undefined ? parsed.stream : true;

        const newBody = JSON.stringify(parsed);
        const targetPath = backendUrl.pathname.replace(/\/$/, '') + '/api/v1/chat/completions';

        const options = {
          hostname: backendUrl.hostname,
          port: backendUrl.port || 443,
          path: targetPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
            'User-Agent': 'ai-sdk/openai-compatible/codebuff',
            'Accept': parsed.stream ? 'text/event-stream' : 'application/json',
            'Content-Length': Buffer.byteLength(newBody),
          },
        };

        const proxyReq = httpModule.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);

          if (parsed.stream) {
            // SSE streaming
            proxyRes.on('data', (chunk) => {
              res.write(chunk);
            });
            proxyRes.on('end', () => {
              res.end();
              // Finish agent run
              finishAgentRun(runId, 'FINISHED').catch(console.error);
            });
          } else {
            proxyRes.on('data', (chunk) => { res.write(chunk); });
            proxyRes.on('end', () => {
              res.end();
              finishAgentRun(runId, 'FINISHED').catch(console.error);
            });
          }
        });

        proxyReq.on('error', (e) => {
          console.error('[ERROR] Proxy request failed:', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        });

        proxyReq.write(newBody);
        proxyReq.end();
      } catch (e) {
        console.error('[ERROR] Internal error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
      }
    });
    return;
  }

  // All other /v1/ paths - pass through
  if (req.url.startsWith('/v1/')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const targetPath = backendUrl.pathname.replace(/\/$/, '') + req.url.replace('/v1/', '/api/v1/');

      const options = {
        hostname: backendUrl.hostname,
        port: backendUrl.port || 443,
        path: targetPath,
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'User-Agent': 'ai-sdk/openai-compatible/codebuff',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      };

      const proxyReq = httpModule.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.on('data', (chunk) => { res.write(chunk); });
        proxyRes.on('end', () => { res.end(); });
      });

      proxyReq.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
      });

      if (body) proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found. Use /v1/chat/completions', type: 'invalid_request_error' } }));
}

function finishAgentRun(runId, status) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action: 'FINISH', runId, status });
    const options = {
      hostname: backendUrl.hostname,
      port: backendUrl.port || 443,
      path: '/api/v1/agent-runs',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = httpModule.request(options, () => { resolve(); });
    req.on('error', () => { resolve(); }); // best effort
    req.write(body);
    req.end();
  });
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`[INFO] Proxy server listening on port ${PORT}`);
  console.log(`[INFO] Backend: ${BACKEND_URL}`);
  console.log(`[INFO] Key: ${API_KEY.substring(0, 8)}...`);
});