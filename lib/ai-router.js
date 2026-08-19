const http = require('http');
const https = require('https');

function createAiRouter(options = {}) {
  const store = options.store;
  const getConfig = options.getConfig || (() => store.load());
  const routeMap = {
    '/router/anthropic': 'claude',
    '/router/openai': 'codex',
  };

  function collectBody(req, maxBytes = 20 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function isAuthorized(req, config) {
    const expected = String(config.virtualApiKey || '').trim();
    const auth = String(req.headers.authorization || '');
    const apiKey = String(req.headers['x-api-key'] || '');
    return !!expected && (auth === `Bearer ${expected}` || apiKey === expected);
  }

  function sendError(res, status, message) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { type: 'cc_web_router_error', message } }));
  }

  function forward(req, res, provider, body) {
    const upstream = new URL(provider.baseUrl);
    const endpoint = provider.agent === 'claude' ? '/messages' : '/responses';
    const targetPath = `${upstream.pathname.replace(/\/$/, '')}${endpoint}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
    const headers = { ...req.headers, host: upstream.host, 'content-length': Buffer.byteLength(body) };
    delete headers.authorization;
    delete headers['x-api-key'];
    delete headers['anthropic-auth-token'];
    delete headers['api-key'];
    delete headers['x-goog-api-key'];
    delete headers['content-encoding'];
    if (provider.agent === 'claude') {
      headers['x-api-key'] = provider.apiKey;
      // Anthropic 官方使用 x-api-key，部分兼容网关只读取 Bearer。
      // 两者都使用真实提供方 Key，绝不透传 cc-web 虚拟 Key。
      headers.authorization = `Bearer ${provider.apiKey}`;
      headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
    } else {
      headers.authorization = `Bearer ${provider.apiKey}`;
    }
    const transport = upstream.protocol === 'https:' ? https : http;
    const upstreamReq = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: targetPath || '/',
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', (error) => sendError(res, 502, `上游请求失败: ${error.message}`));
    upstreamReq.end(body);
  }

  async function handle(req, res) {
    const requestPath = req.url.split('?')[0];
    const routeKey = Object.keys(routeMap).find((key) => requestPath === key || requestPath.startsWith(`${key}/`));
    const agent = routeKey ? routeMap[routeKey] : null;
    if (!agent) return false;
    if (req.method !== 'POST') {
      sendError(res, 405, '路由只支持 POST');
      return true;
    }
    const config = getConfig();
    if (!isAuthorized(req, config)) {
      sendError(res, 401, '路由鉴权失败');
      return true;
    }
    let body;
    try {
      body = await collectBody(req);
      const payload = JSON.parse(body.toString('utf8'));
      const parsed = store.parseSelection(payload.model);
      if (!parsed) return sendError(res, 400, '模型必须使用 providerId/modelId 格式');
      const selection = store.resolveSelection(config, agent, parsed.providerId, parsed.modelId);
      if (!selection || selection.provider.kind === 'local' || !selection.provider.baseUrl || !selection.provider.apiKey) {
        return sendError(res, 400, '提供方未配置可用的远程 Base URL 或 API Key');
      }
      payload.model = selection.model.id;
      const rewritten = Buffer.from(JSON.stringify(payload));
      forward(req, res, selection.provider, rewritten);
    } catch (error) {
      sendError(res, 400, error.message || '无效请求');
    }
    return true;
  }

  return { handle };
}

module.exports = { createAiRouter };
