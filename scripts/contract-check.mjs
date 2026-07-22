import assert from 'node:assert/strict';

import accountSync, {
  buildReadbackResponse,
  buildWriteResponse,
  normaliseAccountSyncRequest,
} from '../api/account-sync.js';
import geminiStockInsight from '../api/gemini-stock-insight.js';
import cronMarketDataRefresh from '../api/cron/market-data-refresh.js';
import marketDataRefresh from '../api/market-data-refresh.js';
import queryParse from '../api/query-parse.js';
import { requireCronSecret } from '../lib/relay-security.js';

const controlledEnvironment = [
  'GEMINI_API_KEY',
  'GEMINI_ALLOWED_MODELS',
  'GEMINI_QUERY_ALLOWED_MODELS',
  'GEMINI_INSIGHT_ALLOWED_MODELS',
  'GEMINI_MODEL',
  'GEMINI_QUERY_MODEL',
  'GEMINI_INSIGHT_MODEL',
  'STOCKAI_ALLOWED_ORIGINS',
  'STOCKAI_RELAY_TOKEN',
  'STOCKAI_WEB_BFF_TOKEN',
  'STOCKAI_QUERY_TOKEN',
  'STOCKAI_INSIGHT_TOKEN',
  'STOCKAI_SYNC_TOKEN',
  'STOCKAI_MARKET_TOKEN',
  'CRON_SECRET',
];
const originalEnvironment = new Map(
  controlledEnvironment.map((name) => [name, process.env[name]]),
);

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.body = undefined;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(payload) {
    this.body = payload;
    return this;
  }

  end() {
    return this;
  }
}

const cases = [
  {
    name: 'cross-origin browser request is rejected before authentication',
    handler: queryParse,
    request: {
      headers: { origin: 'https://untrusted.example' },
      body: {},
    },
    expectedStatus: 403,
    expectedCode: 'ORIGIN_NOT_ALLOWED',
  },
  {
    name: 'same-origin preflight does not require the relay token',
    handler: queryParse,
    request: {
      method: 'OPTIONS',
      headers: { origin: 'https://relay.example' },
    },
    expectedStatus: 204,
  },
  {
    name: 'query relay reports missing server token as unavailable',
    handler: queryParse,
    request: { body: { query: 'AAPL' } },
    expectedStatus: 503,
    expectedCode: 'RELAY_TOKEN_NOT_CONFIGURED',
  },
  {
    name: 'query relay rejects an invalid token',
    handler: queryParse,
    environment: { STOCKAI_RELAY_TOKEN: 'contract-token' },
    request: {
      headers: { 'x-stockai-demo-token': 'wrong-token' },
      body: { query: 'AAPL' },
    },
    expectedStatus: 401,
    expectedCode: 'INVALID_RELAY_TOKEN',
  },
  {
    name: 'query relay accepts the optional web BFF token',
    handler: queryParse,
    environment: { STOCKAI_WEB_BFF_TOKEN: 'web-bff-contract-token' },
    request: {
      headers: { 'x-stockai-demo-token': 'web-bff-contract-token' },
      body: { query: 'AAPL' },
    },
    expectedStatus: 503,
    expectedCode: 'SERVICE_NOT_CONFIGURED',
  },
  {
    name: 'query relay enforces the 16 KiB body limit',
    handler: queryParse,
    environment: {
      STOCKAI_RELAY_TOKEN: 'contract-token',
      GEMINI_API_KEY: 'not-a-real-key',
    },
    request: {
      headers: { 'x-stockai-demo-token': 'contract-token' },
      body: { query: 'x'.repeat(17_000) },
    },
    expectedStatus: 413,
    expectedCode: 'REQUEST_BODY_TOO_LARGE',
  },
  {
    name: 'query relay rejects a client model outside the server allow-list',
    handler: queryParse,
    environment: {
      STOCKAI_RELAY_TOKEN: 'contract-token',
      GEMINI_API_KEY: 'not-a-real-key',
      GEMINI_MODEL: 'gemini-3.5-flash',
    },
    request: {
      headers: { 'x-stockai-demo-token': 'contract-token' },
      body: { query: 'AAPL', fallback: {}, model: 'unapproved-model' },
    },
    expectedStatus: 400,
    expectedCode: 'MODEL_NOT_ALLOWED',
  },
  {
    name: 'insight relay validates stock symbols before calling Gemini',
    handler: geminiStockInsight,
    environment: {
      STOCKAI_RELAY_TOKEN: 'contract-token',
      GEMINI_API_KEY: 'not-a-real-key',
    },
    request: {
      headers: { 'x-stockai-demo-token': 'contract-token' },
      body: { stock: { symbol: '../../secret' }, userProfile: {} },
    },
    expectedStatus: 400,
    expectedCode: 'INVALID_REQUEST',
  },
  {
    name: 'account sync rejects mismatched account identities before Firebase',
    handler: accountSync,
    environment: { STOCKAI_RELAY_TOKEN: 'contract-token' },
    request: {
      headers: { 'x-stockai-demo-token': 'contract-token' },
      body: {
        action: 'write',
        accountId: 'account-web-001',
        snapshot: sampleSnapshot('account-mobile-001'),
      },
    },
    expectedStatus: 409,
    expectedCode: 'ACCOUNT_ID_MISMATCH',
  },
  {
    name: 'account sync enforces snapshot collection bounds',
    handler: accountSync,
    environment: { STOCKAI_RELAY_TOKEN: 'contract-token' },
    request: {
      headers: { 'x-stockai-demo-token': 'contract-token' },
      body: {
        action: 'write',
        accountId: 'account-web-001',
        snapshot: {
          ...sampleSnapshot('account-web-001'),
          watchlist_symbols: Array.from({ length: 61 }, () => 'AAPL'),
        },
      },
    },
    expectedStatus: 400,
    expectedCode: 'SNAPSHOT_ITEM_LIMIT_EXCEEDED',
  },
  {
    name: 'account readback rejects write-only fields before Firebase',
    handler: accountSync,
    environment: { STOCKAI_RELAY_TOKEN: 'contract-token' },
    request: {
      headers: { 'x-stockai-demo-token': 'contract-token' },
      body: {
        action: 'readback',
        accountId: 'account-web-001',
        snapshot: sampleSnapshot('account-web-001'),
      },
    },
    expectedStatus: 400,
    expectedCode: 'INVALID_SYNC_PAYLOAD',
  },
  {
    name: 'market refresh enforces the symbol-count bound before Firebase',
    handler: marketDataRefresh,
    environment: { STOCKAI_RELAY_TOKEN: 'contract-token' },
    request: {
      headers: { 'x-stockai-demo-token': 'contract-token' },
      body: {
        symbols: Array.from({ length: 13 }, (_, index) => `A${index}`),
      },
    },
    expectedStatus: 400,
    expectedCode: 'SYMBOL_LIMIT_EXCEEDED',
  },
  {
    name: 'cron refresh accepts GET only',
    handler: cronMarketDataRefresh,
    environment: { CRON_SECRET: 'cron-contract-secret' },
    request: { method: 'POST' },
    expectedStatus: 405,
    expectedCode: 'METHOD_NOT_ALLOWED',
  },
  {
    name: 'cron refresh reports missing server secret as unavailable',
    handler: cronMarketDataRefresh,
    request: { method: 'GET' },
    expectedStatus: 503,
    expectedCode: 'CRON_SECRET_NOT_CONFIGURED',
  },
  {
    name: 'cron refresh rejects an invalid bearer secret',
    handler: cronMarketDataRefresh,
    environment: { CRON_SECRET: 'cron-contract-secret' },
    request: {
      method: 'GET',
      headers: { authorization: 'Bearer wrong-secret' },
    },
    expectedStatus: 401,
    expectedCode: 'INVALID_CRON_SECRET',
  },
];

const directContractCases = [
  {
    name: 'legacy Flutter write shape remains compatible without enabling readback ambiguity',
    check() {
      const command = normaliseAccountSyncRequest({
        accountId: 'account-mobile-001',
        snapshot: sampleSnapshot('account-mobile-001'),
      });
      assert.equal(command.action, 'write');
      assert.equal(command.accountId, command.snapshot.account.id);
      assert.deepEqual(Object.keys(command), ['action', 'accountId', 'snapshot']);
    },
  },
  {
    name: 'account write request normalises to one identity and exact action shape',
    check() {
      const command = normaliseAccountSyncRequest({
        action: 'write',
        accountId: 'account-web-001',
        snapshot: sampleSnapshot('account-web-001'),
      });
      assert.equal(command.action, 'write');
      assert.equal(command.accountId, command.snapshot.account.id);
      assert.deepEqual(Object.keys(command), ['action', 'accountId', 'snapshot']);
    },
  },
  {
    name: 'account write success exposes only the documented allow-list',
    check() {
      const payload = buildWriteResponse({
        accountId: 'account-web-001',
        summary: sampleSummary(),
        snapshotDigest: 'a'.repeat(64),
        requestId: 'contract-request-001',
      });
      assert.deepEqual(Object.keys(payload), [
        'ok',
        'action',
        'accountId',
        'summary',
        'snapshotDigest',
        'source',
        'transport',
        'requestId',
      ]);
      assert.equal(payload.action, 'write');
      assert.equal(payload.accountId, 'account-web-001');
      assert.equal(payload.snapshotDigest, 'a'.repeat(64));
      assert.equal(Object.hasOwn(payload, 'snapshot'), false);
    },
  },
  {
    name: 'account readback success projects identity without the stored snapshot',
    check() {
      const payload = buildReadbackResponse({
        found: true,
        accountId: 'account-web-001',
        summary: sampleSummary(),
        snapshotDigest: 'b'.repeat(64),
        updatedAt: '2026-07-16T00:00:00.000Z',
        requestId: 'contract-request-002',
      });
      assert.deepEqual(Object.keys(payload), [
        'ok',
        'action',
        'found',
        'accountId',
        'summary',
        'snapshotDigest',
        'updatedAt',
        'source',
        'transport',
        'requestId',
      ]);
      assert.equal(payload.action, 'readback');
      assert.equal(payload.found, true);
      assert.equal(payload.accountId, 'account-web-001');
      assert.equal(payload.snapshotDigest, 'b'.repeat(64));
      assert.equal(Object.hasOwn(payload, 'snapshot'), false);
    },
  },
  {
    name: 'missing account readback retains the allow-list with null evidence',
    check() {
      const payload = buildReadbackResponse({
        found: false,
        accountId: 'account-web-404',
        summary: null,
        snapshotDigest: null,
        updatedAt: null,
        requestId: 'contract-request-404',
      });
      assert.equal(payload.accountId, 'account-web-404');
      assert.equal(payload.summary, null);
      assert.equal(payload.snapshotDigest, null);
      assert.equal(payload.updatedAt, null);
    },
  },
  {
    name: 'cron authentication accepts the configured bearer secret',
    check() {
      const previous = applyEnvironment({ CRON_SECRET: 'cron-contract-secret' });
      try {
        assert.doesNotThrow(() => requireCronSecret({
          headers: { authorization: 'Bearer cron-contract-secret' },
        }));
      } finally {
        restoreEnvironment(previous);
      }
    },
  },
];

let failures = 0;
try {
  resetControlledEnvironment();
  process.env.STOCKAI_ALLOWED_ORIGINS = 'https://relay.example';

  for (const contractCase of cases) {
    const previous = applyEnvironment(contractCase.environment || {});
    try {
      const response = await invoke(contractCase.handler, contractCase.request);
      assert.equal(response.statusCode, contractCase.expectedStatus);
      if (contractCase.expectedCode) {
        assert.equal(readErrorCode(response.body), contractCase.expectedCode);
        assert.match(response.body.requestId, /^[A-Za-z0-9._:-]{8,128}$/);
        assert.equal(response.headers.get('x-request-id'), response.body.requestId);
      }
      process.stdout.write(`PASS ${contractCase.name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(
        `FAIL ${contractCase.name}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      restoreEnvironment(previous);
    }
  }

  for (const contractCase of directContractCases) {
    try {
      contractCase.check();
      process.stdout.write(`PASS ${contractCase.name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(
        `FAIL ${contractCase.name}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
} finally {
  restoreEnvironment(originalEnvironment);
}

if (failures) {
  process.exitCode = 1;
} else {
  process.stdout.write(
    `VALID relay-contract cases=${cases.length + directContractCases.length}\n`,
  );
}

async function invoke(handler, requestInput = {}) {
  const response = new MockResponse();
  const request = {
    method: requestInput.method || 'POST',
    headers: {
      host: 'relay.example',
      'x-forwarded-proto': 'https',
      ...(requestInput.method === 'OPTIONS'
        ? {}
        : { 'content-type': 'application/json' }),
      ...(requestInput.headers || {}),
    },
    body: requestInput.body,
  };
  await handler(request, response);
  return response;
}

function sampleSnapshot(accountId) {
  return {
    account: { id: accountId, display_name: 'Contract checker' },
    risk_profile: { goal: 'research', risk_tolerance: 'moderate' },
    watchlist_symbols: ['AAPL'],
    watchlist_stocks: [],
    saved_screens: [],
    alert_rules: [],
    summary: {},
    updated_at: '2026-07-16T00:00:00.000Z',
    source: 'stockai_contract_checker',
  };
}

function sampleSummary() {
  return {
    watchlist_symbols: 1,
    watchlist_stocks: 0,
    saved_screens: 0,
    alert_rules: 0,
  };
}

function readErrorCode(payload) {
  return payload?.error?.code || payload?.errorCode || '';
}

function resetControlledEnvironment() {
  for (const name of controlledEnvironment) delete process.env[name];
}

function applyEnvironment(values) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined || value === null) delete process.env[name];
    else process.env[name] = String(value);
  }
  return previous;
}

function restoreEnvironment(values) {
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
