import { getFirestore, serverTimestamp } from '../lib/firebase-admin.js';
import {
  RelayError,
  applyCors,
  beginRequest,
  readJsonBody,
  requirePlainObject,
  requirePostJson,
  sendError,
  withTimeout,
} from '../lib/relay-http.js';
import { requireRelayToken, stableSha256 } from '../lib/relay-security.js';

const defaultCollection = 'mobile_account_sync';
const maximumSnapshotBytes = 262_144;
const firebaseStageTimeoutMs = 6_000;
const responseSource = 'firebase-admin';
const responseTransport = 'vercel-relay';

export default async function handler(request, response) {
  const requestId = beginRequest(request, response);
  try {
    const corsResult = applyCors(request, response);
    if (!corsResult.allowed) {
      throw new RelayError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed.');
    }
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }

    requirePostJson(request, response);
    requireRelayToken(request, ['STOCKAI_SYNC_TOKEN', 'STOCKAI_RELAY_TOKEN'], 'Account sync');
    const body = requirePlainObject(
      await readJsonBody(request, { maxBytes: maximumSnapshotBytes }),
    );
    const command = normaliseAccountSyncRequest(body);

    const collection = sanitiseCollectionName(
      process.env.FIREBASE_ACCOUNT_SYNC_COLLECTION || defaultCollection,
    );
    const firestore = getFirestore();
    const documentReference = firestore.collection(collection).doc(command.accountId);

    if (command.action === 'write') {
      const snapshotDigest = stableSha256(command.snapshot);
      try {
        await withTimeout(
          documentReference.set(
            {
              ...command.snapshot,
              account_id: command.accountId,
              summary: command.snapshot.summary,
              snapshot_digest: snapshotDigest,
              relay_request_id: requestId,
              relay_updated_at: serverTimestamp(),
            },
            { merge: true },
          ),
          firebaseStageTimeoutMs,
          'FIREBASE_WRITE_TIMEOUT',
          'Firebase account sync timed out.',
        );
      } catch (error) {
        if (error instanceof RelayError) throw error;
        throw new RelayError(
          502,
          'FIREBASE_WRITE_FAILED',
          'Firebase account sync could not be completed.',
        );
      }

      response.status(200).json(buildWriteResponse({
        accountId: command.accountId,
        summary: command.snapshot.summary,
        snapshotDigest,
        requestId,
      }));
      return;
    }

    let documentSnapshot;
    try {
      documentSnapshot = await withTimeout(
        documentReference.get(),
        firebaseStageTimeoutMs,
        'FIREBASE_READ_TIMEOUT',
        'Firebase account readback timed out.',
      );
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError(
        502,
        'FIREBASE_READ_FAILED',
        'Firebase account readback could not be completed.',
      );
    }

    if (!documentSnapshot.exists) {
      response.status(200).json(buildReadbackResponse({
        found: false,
        accountId: command.accountId,
        summary: null,
        snapshotDigest: null,
        updatedAt: null,
        requestId,
      }));
      return;
    }

    const stored = requireStoredDocument(documentSnapshot.data(), command.accountId);
    response.status(200).json(buildReadbackResponse({
      found: true,
      accountId: command.accountId,
      summary: stored.summary,
      snapshotDigest: stored.snapshotDigest,
      updatedAt: stored.updatedAt,
      requestId,
    }));
  } catch (error) {
    sendError(response, error, requestId, { legacyString: true });
  }
}

export function normaliseAccountSyncRequest(body) {
  // Existing Flutter builds predate the readback action and send the write
  // shape without an action field. Keep that exact legacy shape working while
  // the Web BFF remains strict and always sends an explicit action.
  const legacyMobileWrite = body.action === undefined && body.snapshot !== undefined;
  const action = legacyMobileWrite ? 'write' : String(body.action || '').trim();
  if (action !== 'write' && action !== 'readback') {
    throw new RelayError(
      400,
      'INVALID_SYNC_ACTION',
      'action must be either write or readback.',
    );
  }

  const allowedKeys = action === 'write'
    ? legacyMobileWrite
      ? ['accountId', 'snapshot']
      : ['action', 'accountId', 'snapshot']
    : ['action', 'accountId'];
  requireExactKeys(body, allowedKeys);
  const accountId = sanitiseDocumentId(body.accountId);

  if (action === 'readback') {
    return { action, accountId };
  }

  const snapshot = normaliseSnapshot(body.snapshot);
  if (accountId !== snapshot.account.id) {
    throw new RelayError(
      409,
      'ACCOUNT_ID_MISMATCH',
      'accountId must match snapshot.account.id.',
    );
  }
  return { action, accountId, snapshot };
}

export function buildWriteResponse({ accountId, summary, snapshotDigest, requestId }) {
  return {
    ok: true,
    action: 'write',
    accountId,
    summary: normaliseSummary(summary, 'INVALID_RESPONSE_SUMMARY', 500),
    snapshotDigest: normaliseDigest(snapshotDigest, 'INVALID_RESPONSE_DIGEST', 500),
    source: responseSource,
    transport: responseTransport,
    requestId,
  };
}

export function buildReadbackResponse({
  found,
  accountId,
  summary,
  snapshotDigest,
  updatedAt,
  requestId,
}) {
  if (typeof found !== 'boolean') {
    throw new RelayError(500, 'INVALID_READBACK_RESPONSE', 'Invalid readback response state.');
  }
  return {
    ok: true,
    action: 'readback',
    found,
    accountId,
    summary: found
      ? normaliseSummary(summary, 'INVALID_RESPONSE_SUMMARY', 500)
      : null,
    snapshotDigest: found
      ? normaliseDigest(snapshotDigest, 'INVALID_RESPONSE_DIGEST', 500)
      : null,
    updatedAt: found
      ? normaliseStoredTimestamp(updatedAt)
      : null,
    source: responseSource,
    transport: responseTransport,
    requestId,
  };
}

function requireExactKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = allowedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unexpected.length || missing.length) {
    throw new RelayError(
      400,
      'INVALID_SYNC_PAYLOAD',
      `Request must contain exactly: ${allowedKeys.join(', ')}.`,
    );
  }
}

function requireStoredDocument(value, requestedAccountId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayError(
      502,
      'FIREBASE_DOCUMENT_INVALID',
      'Firebase account readback returned an invalid document.',
    );
  }
  const storedAccountId = String(value.account_id || value.account?.id || '').trim();
  if (storedAccountId !== requestedAccountId) {
    throw new RelayError(
      502,
      'FIREBASE_IDENTITY_MISMATCH',
      'Firebase account readback identity did not match the request.',
    );
  }
  return {
    summary: normaliseSummary(value.summary, 'FIREBASE_DOCUMENT_INVALID', 502),
    snapshotDigest: normaliseDigest(
      value.snapshot_digest,
      'FIREBASE_DOCUMENT_INVALID',
      502,
    ),
    updatedAt: normaliseStoredTimestamp(value.relay_updated_at),
  };
}

function normaliseSummary(value, code, status) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayError(status, code, 'Account summary is invalid.');
  }
  const keys = [
    'watchlist_symbols',
    'watchlist_stocks',
    'saved_screens',
    'alert_rules',
  ];
  const summary = {};
  for (const key of keys) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RelayError(status, code, 'Account summary is invalid.');
    }
    summary[key] = count;
  }
  return summary;
}

function normaliseDigest(value, code, status) {
  const digest = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new RelayError(status, code, 'Account snapshot digest is invalid.');
  }
  return digest;
}

function normaliseStoredTimestamp(value) {
  let candidate = value;
  if (candidate && typeof candidate.toDate === 'function') {
    try {
      candidate = candidate.toDate();
    } catch {
      candidate = null;
    }
  } else if (candidate && typeof candidate === 'object') {
    const seconds = Number(candidate.seconds ?? candidate._seconds);
    const nanoseconds = Number(candidate.nanoseconds ?? candidate._nanoseconds ?? 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanoseconds)) {
      candidate = new Date((seconds * 1_000) + Math.floor(nanoseconds / 1_000_000));
    }
  }
  const timestamp = candidate instanceof Date
    ? candidate.getTime()
    : Date.parse(String(candidate || ''));
  if (!Number.isFinite(timestamp)) {
    throw new RelayError(
      502,
      'FIREBASE_DOCUMENT_INVALID',
      'Firebase account readback timestamp is invalid.',
    );
  }
  return new Date(timestamp).toISOString();
}

function normaliseSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayError(400, 'INVALID_SNAPSHOT', 'snapshot payload is required.');
  }
  const account = normaliseObject(value.account, 'account');
  const accountId = sanitiseDocumentId(account.id);
  const watchlistSymbols = normaliseSymbolArray(
    value.watchlist_symbols,
    'watchlist_symbols',
    60,
  );
  const watchlistStocks = normaliseObjectArray(
    value.watchlist_stocks,
    'watchlist_stocks',
    60,
  );
  const savedScreens = normaliseObjectArray(
    value.saved_screens,
    'saved_screens',
    80,
  );
  const alertRules = normaliseObjectArray(
    value.alert_rules,
    'alert_rules',
    80,
  );

  return {
    account: {
      ...account,
      id: accountId,
    },
    risk_profile: normaliseObject(value.risk_profile, 'risk_profile'),
    watchlist_symbols: watchlistSymbols,
    watchlist_stocks: watchlistStocks,
    saved_screens: savedScreens,
    alert_rules: alertRules,
    summary: {
      watchlist_symbols: watchlistSymbols.length,
      watchlist_stocks: watchlistStocks.length,
      saved_screens: savedScreens.length,
      alert_rules: alertRules.length,
    },
    updated_at: normaliseTimestamp(value.updated_at),
    source: cleanText(value.source, 'stockai_mobile_flutter', 64),
  };
}

function normaliseObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayError(400, 'INVALID_SNAPSHOT_FIELD', `${fieldName} must be an object.`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new RelayError(400, 'INVALID_SNAPSHOT_FIELD', `${fieldName} must be JSON serialisable.`);
  }
}

function normaliseObjectArray(value, fieldName, limit) {
  if (!Array.isArray(value)) {
    throw new RelayError(400, 'INVALID_SNAPSHOT_FIELD', `${fieldName} must be an array.`);
  }
  if (value.length > limit) {
    throw new RelayError(
      400,
      'SNAPSHOT_ITEM_LIMIT_EXCEEDED',
      `${fieldName} must contain at most ${limit} items.`,
    );
  }
  return value.map((item, index) => normaliseObject(item, `${fieldName}[${index}]`));
}

function normaliseSymbolArray(value, fieldName, limit) {
  if (!Array.isArray(value)) {
    throw new RelayError(400, 'INVALID_SNAPSHOT_FIELD', `${fieldName} must be an array.`);
  }
  if (value.length > limit) {
    throw new RelayError(
      400,
      'SNAPSHOT_ITEM_LIMIT_EXCEEDED',
      `${fieldName} must contain at most ${limit} items.`,
    );
  }
  const symbols = [];
  const seen = new Set();
  for (const item of value) {
    const symbol = String(item || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
      throw new RelayError(400, 'INVALID_SYMBOL', 'watchlist_symbols contains an invalid symbol.');
    }
    if (!seen.has(symbol)) {
      seen.add(symbol);
      symbols.push(symbol);
    }
  }
  return symbols;
}

function sanitiseDocumentId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{3,128}$/.test(id) || id.includes('/')) {
    throw new RelayError(400, 'INVALID_ACCOUNT_ID', 'Invalid account id.');
  }
  return id;
}

function sanitiseCollectionName(value) {
  const name = String(value || defaultCollection).trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(name)) {
    throw new RelayError(
      503,
      'FIREBASE_COLLECTION_NOT_CONFIGURED',
      'Firebase account sync collection is not configured correctly.',
    );
  }
  return name;
}

function normaliseTimestamp(value) {
  const text = String(value || '').trim();
  const timestamp = Date.parse(text);
  if (!text || text.length > 40 || !Number.isFinite(timestamp)) {
    throw new RelayError(400, 'INVALID_UPDATED_AT', 'updated_at must be an ISO date-time.');
  }
  return new Date(timestamp).toISOString();
}

function cleanText(value, fallback, maxLength) {
  const text = String(value ?? fallback)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return text || fallback;
}
