import { createHash, timingSafeEqual } from 'node:crypto';

import { RelayError } from './relay-http.js';

const defaultModel = 'gemini-3.5-flash';
const legacyClientModels = new Set(['gemini-3-flash-preview']);
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function requireRelayToken(request, envNames, label) {
  const configuredToken = firstConfiguredEnv(envNames);
  const webBffToken = String(process.env.STOCKAI_WEB_BFF_TOKEN || '').trim();
  const acceptedTokens = [configuredToken, webBffToken].filter(Boolean);
  if (!acceptedTokens.length) {
    throw new RelayError(
      503,
      'RELAY_TOKEN_NOT_CONFIGURED',
      `${label} relay token is not configured.`,
    );
  }

  const receivedToken = request.headers?.['x-stockai-demo-token'];
  if (!acceptedTokens.some((token) => tokensMatch(receivedToken, token))) {
    throw new RelayError(401, 'INVALID_RELAY_TOKEN', 'Invalid relay token.');
  }
}

export function requireCronSecret(request) {
  const configuredSecret = String(process.env.CRON_SECRET || '').trim();
  if (!configuredSecret) {
    throw new RelayError(
      503,
      'CRON_SECRET_NOT_CONFIGURED',
      'Cron authentication is not configured.',
    );
  }

  const receivedAuthorization = request.headers?.authorization;
  if (!tokensMatch(receivedAuthorization, `Bearer ${configuredSecret}`)) {
    throw new RelayError(401, 'INVALID_CRON_SECRET', 'Invalid cron authorization.');
  }
}

export function requireEnvironment(name, publicLabel = name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new RelayError(
      503,
      'SERVICE_NOT_CONFIGURED',
      `${publicLabel} is not configured.`,
    );
  }
  return value;
}

export function resolveGeminiModel(requestedModel, purpose) {
  const purposeName = purpose === 'query' ? 'QUERY' : 'INSIGHT';
  const configuredModel = String(
    process.env[`GEMINI_${purposeName}_MODEL`]
      || process.env.GEMINI_MODEL
      || defaultModel,
  ).trim();
  if (!modelPattern.test(configuredModel)) {
    throw new RelayError(
      503,
      'MODEL_POLICY_NOT_CONFIGURED',
      'Gemini model policy is not configured correctly.',
    );
  }

  const configuredAllowList = [
    ...parseCsv(process.env.GEMINI_ALLOWED_MODELS),
    ...parseCsv(process.env[`GEMINI_${purposeName}_ALLOWED_MODELS`]),
  ];
  const allowedModels = new Set(
    (configuredAllowList.length ? configuredAllowList : [configuredModel])
      .filter((model) => modelPattern.test(model)),
  );
  allowedModels.add(configuredModel);

  const requested = String(requestedModel || '').trim();
  const selected = !requested || legacyClientModels.has(requested)
    ? configuredModel
    : requested;
  if (!modelPattern.test(selected) || !allowedModels.has(selected)) {
    throw new RelayError(
      400,
      'MODEL_NOT_ALLOWED',
      'Requested Gemini model is not permitted by the server policy.',
    );
  }

  return {
    model: selected,
    configuredModel,
    requestedModel: requested || null,
  };
}

export function geminiUpstreamError(status) {
  if (status === 429) {
    return new RelayError(429, 'GEMINI_RATE_LIMITED', 'Gemini is temporarily rate limited.');
  }
  if (status === 408 || status === 504) {
    return new RelayError(504, 'GEMINI_TIMEOUT', 'Gemini request timed out.');
  }
  return new RelayError(502, 'GEMINI_UPSTREAM_ERROR', 'Gemini could not complete the request.');
}

export function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

export function stableSha256(value) {
  return createHash('sha256').update(stableSerialise(value)).digest('hex');
}

export function safeProviderModelVersion(value, fallback) {
  const model = String(value || '').trim();
  return modelPattern.test(model) ? model : fallback;
}

function firstConfiguredEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokensMatch(receivedValue, configuredToken) {
  const received = Buffer.from(String(receivedValue || ''));
  const expected = Buffer.from(configuredToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function stableSerialise(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialise).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialise(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
