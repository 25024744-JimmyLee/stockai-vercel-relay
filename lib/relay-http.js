import { randomUUID } from 'node:crypto';

const requestIdPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export class RelayError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function beginRequest(request, response) {
  const supplied = String(request.headers?.['x-request-id'] || '').trim();
  const requestId = requestIdPattern.test(supplied) ? supplied : randomUUID();
  response.setHeader('x-request-id', requestId);
  response.setHeader('cache-control', 'no-store');
  return requestId;
}

export function applyCors(request, response) {
  const rawRequestOrigin = String(request.headers?.origin || '').trim();
  const requestOrigin = normaliseOrigin(rawRequestOrigin);
  const invalidRequestOrigin = Boolean(rawRequestOrigin) && !requestOrigin;
  const configuredOrigins = String(process.env.STOCKAI_ALLOWED_ORIGINS || '')
    .split(',')
    .map(normaliseOrigin)
    .filter(Boolean);
  const wildcard = configuredOrigins.includes('*');
  const sameOrigin = Boolean(requestOrigin) && requestOrigin === requestServerOrigin(request);
  const allowed = !rawRequestOrigin
    || (!invalidRequestOrigin && (
      sameOrigin
      || wildcard
      || configuredOrigins.includes(requestOrigin)
    ));

  response.setHeader('vary', 'Origin');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  response.setHeader(
    'access-control-allow-headers',
    'content-type, x-stockai-demo-token, x-request-id',
  );
  response.setHeader('access-control-expose-headers', 'x-request-id');
  response.setHeader('access-control-max-age', '86400');
  if (allowed && requestOrigin) {
    response.setHeader('access-control-allow-origin', wildcard ? '*' : requestOrigin);
  }

  return { allowed, requestOrigin, sameOrigin };
}

export function requirePostJson(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST, OPTIONS');
    throw new RelayError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
  }

  const contentType = String(request.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new RelayError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
  }
}

export async function readJsonBody(request, { maxBytes, allowEmpty = false }) {
  const declaredLength = Number(request.headers?.['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RelayError(
      413,
      'REQUEST_BODY_TOO_LARGE',
      `Request body must not exceed ${formatByteLimit(maxBytes)}.`,
    );
  }

  if (request.body === null && Object.prototype.hasOwnProperty.call(request, 'body')) {
    return allowEmpty ? {} : null;
  }

  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
    let serialised;
    try {
      serialised = JSON.stringify(request.body);
    } catch {
      throw new RelayError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    }
    if (Buffer.byteLength(serialised, 'utf8') > maxBytes) {
      throw new RelayError(
        413,
        'REQUEST_BODY_TOO_LARGE',
        `Request body must not exceed ${formatByteLimit(maxBytes)}.`,
      );
    }
    return request.body;
  }

  if (typeof request.body === 'string' || Buffer.isBuffer(request.body)) {
    const rawBody = Buffer.isBuffer(request.body)
      ? request.body.toString('utf8').trim()
      : request.body.trim();
    if (Buffer.byteLength(rawBody, 'utf8') > maxBytes) {
      throw new RelayError(
        413,
        'REQUEST_BODY_TOO_LARGE',
        `Request body must not exceed ${formatByteLimit(maxBytes)}.`,
      );
    }
    if (!rawBody) {
      if (allowEmpty) return {};
      throw new RelayError(400, 'EMPTY_REQUEST_BODY', 'Request body is empty.');
    }
    try {
      return JSON.parse(rawBody);
    } catch {
      throw new RelayError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    }
  }

  if (request.body !== undefined && request.body !== null) {
    const serialised = JSON.stringify(request.body);
    if (typeof serialised !== 'string') {
      throw new RelayError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    }
    if (Buffer.byteLength(serialised, 'utf8') > maxBytes) {
      throw new RelayError(
        413,
        'REQUEST_BODY_TOO_LARGE',
        `Request body must not exceed ${formatByteLimit(maxBytes)}.`,
      );
    }
    return request.body;
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new RelayError(
        413,
        'REQUEST_BODY_TOO_LARGE',
        `Request body must not exceed ${formatByteLimit(maxBytes)}.`,
      );
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    if (allowEmpty) return {};
    throw new RelayError(400, 'EMPTY_REQUEST_BODY', 'Request body is empty.');
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new RelayError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

export function requirePlainObject(value, fieldName = 'request body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayError(400, 'INVALID_REQUEST', `${fieldName} must be an object.`);
  }
  return value;
}

export async function withTimeout(promise, milliseconds, code, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new RelayError(504, code, message)),
      milliseconds,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function sendError(response, error, requestId, { legacyString = false } = {}) {
  const relayError = asRelayError(error);
  const payload = legacyString
    ? {
        error: relayError.message,
        errorCode: relayError.code,
        ...(relayError.details ? { errorDetails: relayError.details } : {}),
        requestId,
      }
    : {
        error: {
          code: relayError.code,
          message: relayError.message,
          ...(relayError.details ? { details: relayError.details } : {}),
        },
        requestId,
      };
  response.status(relayError.status).json(payload);
}

export function asRelayError(error) {
  if (error instanceof RelayError) return error;
  return new RelayError(500, 'INTERNAL_ERROR', 'The relay could not complete the request.');
}

function requestServerOrigin(request) {
  const host = String(
    request.headers?.['x-forwarded-host'] || request.headers?.host || '',
  ).split(',')[0].trim();
  if (!host) return '';
  const forwardedProtocol = String(request.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const protocol = forwardedProtocol === 'http' || forwardedProtocol === 'https'
    ? forwardedProtocol
    : host.startsWith('localhost') || host.startsWith('127.0.0.1')
      ? 'http'
      : 'https';
  return normaliseOrigin(`${protocol}://${host}`);
}

function normaliseOrigin(value) {
  const text = String(value || '').trim();
  if (!text || text === '*') return text;
  try {
    return new URL(text).origin;
  } catch {
    return '';
  }
}

function formatByteLimit(bytes) {
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`;
}
