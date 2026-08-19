const fs = require('fs');
const path = require('path');

function createAiConfigStore(options = {}) {
  const configDir = options.configDir || path.join(process.cwd(), 'config');
  const filePath = options.filePath || path.join(configDir, 'ai.json');
  const virtualApiKey = String(options.virtualApiKey || 'cc-web-router-key');
  const defaultConfig = {
    version: 1,
    virtualApiKey,
    providers: [
      {
        id: 'claude-local',
        name: '本地 Claude',
        kind: 'local',
        agent: 'claude',
        protocol: 'anthropic-messages',
        baseUrl: '',
        apiKey: '',
        models: [
          { id: 'opus', label: 'Opus' },
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'haiku', label: 'Haiku' },
        ],
      },
      {
        id: 'codex-local',
        name: '本地 Codex',
        kind: 'local',
        agent: 'codex',
        protocol: 'openai-responses',
        baseUrl: '',
        apiKey: '',
        models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
      },
    ],
    defaults: {
      claude: { providerId: 'claude-local', modelId: 'opus' },
      codex: { providerId: 'codex-local', modelId: 'gpt-5.4', reasoningEffort: 'medium' },
    },
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function cleanId(value, allowSlash = false) {
    const id = String(value || '').trim();
    if (!id || /[\r\n]/.test(id) || (!allowSlash && id.includes('/'))) return '';
    return id.slice(0, 300);
  }

  function sanitizeModel(raw) {
    const id = cleanId(raw?.id || raw?.model, true);
    if (!id) return null;
    return { id, label: String(raw?.label || id).trim().slice(0, 200) || id };
  }

  function sanitizeProvider(raw) {
    const agent = raw?.agent === 'codex' ? 'codex' : 'claude';
    const protocol = agent === 'codex' ? 'openai-responses' : 'anthropic-messages';
    const models = [];
    const seen = new Set();
    for (const item of Array.isArray(raw?.models) ? raw.models : []) {
      const model = sanitizeModel(item);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    return {
      id: cleanId(raw?.id),
      name: String(raw?.name || raw?.id || '').trim().slice(0, 100),
      kind: raw?.kind === 'local' ? 'local' : 'remote',
      agent,
      protocol,
      baseUrl: String(raw?.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(raw?.apiKey || ''),
      models,
    };
  }

  function sanitize(raw) {
    const providers = [];
    const seen = new Set();
    for (const item of Array.isArray(raw?.providers) ? raw.providers : []) {
      const provider = sanitizeProvider(item);
      const key = `${provider.agent}:${provider.id}`;
      if (!provider.id || !provider.name || seen.has(key)) continue;
      seen.add(key);
      providers.push(provider);
    }
    const result = {
      version: 1,
      virtualApiKey: String(raw?.virtualApiKey || virtualApiKey).trim() || virtualApiKey,
      providers,
      defaults: {},
    };
    for (const agent of ['claude', 'codex']) {
      const requested = raw?.defaults?.[agent] || {};
      const provider = providers.find((item) => item.id === requested.providerId && item.agent === agent)
        || providers.find((item) => item.agent === agent);
      const model = provider?.models.find((item) => item.id === requested.modelId) || provider?.models[0];
      if (provider && model) {
        result.defaults[agent] = {
          providerId: provider.id,
          modelId: model.id,
          ...(agent === 'codex' ? { reasoningEffort: normalizeReasoningEffort(requested.reasoningEffort) } : {}),
        };
      }
    }
    return result;
  }

  function normalizeReasoningEffort(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['low', 'medium', 'high', 'xhigh'].includes(normalized) ? normalized : 'medium';
  }

  function load() {
    try {
      if (fs.existsSync(filePath)) return sanitize(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {}
    return sanitize(defaultConfig);
  }

  function save(raw) {
    const config = sanitize(raw);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
    return config;
  }

  function getProvider(config, agent, providerId) {
    return (config?.providers || []).find((item) => item.agent === agent && item.id === providerId) || null;
  }

  function resolveSelection(config, agent, providerId, modelId) {
    const defaults = config?.defaults?.[agent] || {};
    const provider = getProvider(config, agent, providerId) || getProvider(config, agent, defaults.providerId)
      || (config?.providers || []).find((item) => item.agent === agent) || null;
    const model = provider?.models.find((item) => item.id === modelId)
      || provider?.models.find((item) => item.id === defaults.modelId)
      || provider?.models[0] || null;
    return provider && model ? { provider, model } : null;
  }

  function selectionValue(selection) {
    return selection ? `${selection.provider.id}/${selection.model.id}` : '';
  }

  function parseSelection(value) {
    const raw = String(value || '').trim();
    const separator = raw.indexOf('/');
    if (separator <= 0 || separator >= raw.length - 1) return null;
    return { providerId: raw.slice(0, separator), modelId: raw.slice(separator + 1) };
  }

  function getPublic(config) {
    const result = sanitize(config || load());
    return {
      version: result.version,
      virtualApiKey: maskSecret(result.virtualApiKey),
      providers: result.providers.map((provider) => ({
        ...provider,
        apiKey: maskSecret(provider.apiKey),
      })),
      defaults: clone(result.defaults),
    };
  }

  function maskSecret(value) {
    const secret = String(value || '');
    if (!secret) return '';
    if (secret.length <= 8) return '****';
    return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
  }

  return {
    filePath,
    defaultConfig: clone(defaultConfig),
    load,
    save,
    sanitize,
    getPublic,
    getProvider,
    resolveSelection,
    selectionValue,
    parseSelection,
    maskSecret,
    normalizeReasoningEffort,
  };
}

module.exports = { createAiConfigStore };
