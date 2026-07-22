import { getFirestore } from '../lib/firebase-admin.js';
import {
  isGitHubMarketStorage,
  readGitHubMarketSnapshot,
  writeGitHubMarketSnapshot,
} from '../lib/github-market-snapshot.js';
import {
  RelayError,
  applyCors,
  asRelayError,
  beginRequest,
  readJsonBody,
  requirePlainObject,
  requirePostJson,
  sendError,
  withTimeout,
} from '../lib/relay-http.js';
import { isTimeoutError, requireRelayToken } from '../lib/relay-security.js';

const defaultCollection = 'market_data';
const refreshStateCollection = 'market_data_meta';
const refreshStateDocument = 'refresh_state';
const freshnessWindowMs = 30 * 60 * 1000;
const refreshLockLeaseMs = 8 * 60 * 1000;
const refreshWaitTimeoutMs = 90 * 1000;
const refreshConcurrency = 12;
const maximumUniverseSymbols = 200;
const maximumRequestSymbols = 12;

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
    requireRelayToken(request, ['STOCKAI_MARKET_TOKEN', 'STOCKAI_RELAY_TOKEN'], 'Market data');
    const body = requirePlainObject(
      await readJsonBody(request, { maxBytes: 8_192, allowEmpty: true }),
    );
    validateRequestSymbols(body.symbols);
    // Browser reads must stay fast. The scheduled cron owns the expensive
    // full-universe Yahoo refresh; a stale snapshot is still useful research
    // input and must not block or multiply refresh jobs per click.
    const result = await loadMarketData(requestId, { allowSynchronousRefresh: false });
    response.status(result.statusCode).json(result.payload);
  } catch (error) {
    const relayError = asRelayError(error);
    console.error(JSON.stringify({
      event: 'market_data_request_failed',
      requestId,
      statusCode: relayError.status,
      errorCode: relayError.code,
      errorMessage: relayError.message,
      underlyingError: error instanceof Error ? error.message : String(error),
    }));
    sendError(response, error, requestId, { legacyString: true });
  }
}

function validateRequestSymbols(value) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length > maximumRequestSymbols) {
    throw new RelayError(
      400,
      'SYMBOL_LIMIT_EXCEEDED',
      `symbols may contain at most ${maximumRequestSymbols} request hints.`,
    );
  }
}

export async function loadMarketData(
  requestId,
  { forceRefresh = false, allowSynchronousRefresh = true } = {},
) {
  if (isGitHubMarketStorage()) {
    return loadGitHubMarketData(requestId, { forceRefresh, allowSynchronousRefresh });
  }

  const firestore = getFirestore();
  const collection = sanitiseCollectionName(
    process.env.FIREBASE_MARKET_DATA_COLLECTION || defaultCollection,
  );
  const stateReference = firestore
    .collection(refreshStateCollection)
    .doc(refreshStateDocument);
  const stateSnapshot = await stateReference.get();
  const state = stateSnapshot.exists ? stateSnapshot.data() || {} : {};

  if (!forceRefresh && isFreshState(state)) {
    return buildMarketDataResponse({
      firestore,
      collection,
      state,
      requestId,
      cacheHit: true,
      updated: [],
      failed: [],
      warnings: [],
    });
  }

  if (!forceRefresh && !allowSynchronousRefresh) {
    return buildMarketDataResponse({
      firestore,
      collection,
      state,
      requestId,
      cacheHit: false,
      updated: [],
      failed: [],
      warnings: [
        'A stale Firestore snapshot was returned without blocking the browser; the scheduled Vercel cron owns the full-universe refresh.',
      ],
    });
  }

  const lock = await acquireRefreshLock(stateReference, requestId, {
    forceRefresh,
  });
  if (lock.fresh && !forceRefresh) {
    return buildMarketDataResponse({
      firestore,
      collection,
      state: lock.state,
      requestId,
      cacheHit: true,
      updated: [],
      failed: [],
      warnings: [],
    });
  }

  if (!lock.acquired) {
    const completedState = await waitForFreshState(stateReference);
    if (!completedState) {
      throw new RelayError(
        503,
        'MARKET_REFRESH_IN_PROGRESS',
        'A full market-data refresh is already in progress. Try again shortly.',
      );
    }
    return buildMarketDataResponse({
      firestore,
      collection,
      state: completedState,
      requestId,
      cacheHit: true,
      updated: [],
      failed: [],
      warnings: ['Another request completed the full Vercel market-data refresh.'],
    });
  }

  try {
    const refresh = await refreshMarketData(undefined, requestId);
    const completedSnapshot = await stateReference.get();
    const completedState = completedSnapshot.exists
      ? completedSnapshot.data() || {}
      : {};
    return buildMarketDataResponse({
      firestore,
      collection,
      state: completedState,
      requestId,
      cacheHit: false,
      updated: refresh.payload.updated,
      failed: refresh.payload.failed,
      warnings: refresh.payload.failed.length
        ? ['Some symbols could not be refreshed; their previous Firestore snapshots were retained.']
        : [],
    });
  } finally {
    await releaseRefreshLock(stateReference, requestId);
  }
}

async function loadGitHubMarketData(
  requestId,
  { forceRefresh, allowSynchronousRefresh },
) {
  let snapshot = await readGitHubMarketSnapshot({ allowMissing: true });
  if (!snapshot && !forceRefresh) {
    throw new RelayError(
      503,
      'GITHUB_SNAPSHOT_NOT_INITIALISED',
      'GitHub market-data snapshot has not been created yet.',
    );
  }

  const state = {
    lastRefreshAt: snapshot?.lastRefreshAt || snapshot?.generatedAt || null,
  };
  if (!forceRefresh && snapshot && isFreshState(state)) {
    return buildGitHubMarketDataResponse({
      snapshot,
      state,
      requestId,
      cacheHit: true,
      updated: [],
      failed: [],
      warnings: [],
    });
  }

  if (!forceRefresh && !allowSynchronousRefresh) {
    return buildGitHubMarketDataResponse({
      snapshot,
      state,
      requestId,
      cacheHit: false,
      updated: [],
      failed: [],
      warnings: [
        'A stale GitHub snapshot was returned without blocking the browser; the scheduled Vercel cron owns the full-universe refresh.',
      ],
    });
  }

  const refresh = await refreshMarketData(undefined, requestId);
  snapshot = await readGitHubMarketSnapshot();
  return buildGitHubMarketDataResponse({
    snapshot,
    state: {
      lastRefreshAt: snapshot.lastRefreshAt || snapshot.generatedAt || null,
    },
    requestId,
    cacheHit: false,
    updated: refresh.payload.updated,
    failed: refresh.payload.failed,
    warnings: refresh.payload.failed.length
      ? ['Some symbols could not be refreshed; their previous GitHub snapshots were retained.']
      : [],
  });
}

export async function refreshMarketData(symbolInput, requestId) {
  const useGitHubStorage = isGitHubMarketStorage();
  const firestore = useGitHubStorage ? null : getFirestore();
  const collection = sanitiseCollectionName(
    process.env.FIREBASE_MARKET_DATA_COLLECTION || defaultCollection,
  );
  const collectionReference = firestore?.collection(collection) || null;
  const existingGitHubSnapshot = useGitHubStorage
    ? await readGitHubMarketSnapshot({ allowMissing: true })
    : null;
  const symbols = await resolveRefreshSymbols(
    symbolInput,
    collectionReference,
    existingGitHubSnapshot?.data,
  );
  const refreshedSnapshots = new Map();
  const attempts = await mapWithConcurrency(symbols, refreshConcurrency, async (symbol) => {
    try {
      const snapshot = await buildMarketSnapshot(symbol);
      if (useGitHubStorage) {
        refreshedSnapshots.set(symbol, snapshot);
      } else {
        try {
          await withTimeout(
            firestore.collection(collection).doc(symbol).set(snapshot, { merge: true }),
            4_000,
            'FIREBASE_WRITE_TIMEOUT',
            'Firebase market-data write timed out.',
          );
        } catch (error) {
          if (error instanceof RelayError) throw error;
          throw new RelayError(
            502,
            'FIREBASE_WRITE_FAILED',
            'Firebase market-data write could not be completed.',
          );
        }
      }
      return {
        symbol,
        ok: true,
        historyPoints: snapshot.history.length,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt,
      };
    } catch (error) {
      const relayError = asRelayError(error);
      return {
        symbol,
        ok: false,
        status: relayError.status,
        errorCode: relayError.code,
      };
    }
  });

  const updated = attempts.filter((item) => item.ok);
  const failed = attempts
    .filter((item) => !item.ok)
    .map(({ symbol, errorCode }) => ({ symbol, errorCode }));
  if (!updated.length) {
    const statuses = attempts.map((item) => item.status);
    const status = statuses.includes(504)
      ? 504
      : statuses.includes(429)
        ? 429
        : statuses.includes(503)
          ? 503
          : statuses.every((value) => value === 422)
            ? 422
            : 502;
    throw new RelayError(
      status,
      'MARKET_REFRESH_FAILED',
      'No market-data symbol could be refreshed.',
      { failed },
    );
  }

  const refreshedAt = new Date().toISOString();
  let github = null;
  if (useGitHubStorage) {
    const dataBySymbol = new Map(
      (existingGitHubSnapshot?.data || []).map((item) => [item.symbol, item]),
    );
    for (const [symbol, snapshot] of refreshedSnapshots) {
      dataBySymbol.set(symbol, snapshot);
    }
    github = await writeGitHubMarketSnapshot({
      data: [...dataBySymbol.values()],
      generatedAt: refreshedAt,
      updatedSymbols: updated.map((item) => item.symbol),
      failed,
    });
  } else {
    await firestore
      .collection(refreshStateCollection)
      .doc(refreshStateDocument)
      .set(
        {
          lastRefreshAt: refreshedAt,
          lastRefreshAttemptAt: refreshedAt,
          lastRefreshStatus: failed.length ? 'partial' : 'success',
          refreshedSymbolCount: updated.length,
          failedSymbolCount: failed.length,
          universeCount: symbols.length,
          source: 'vercel-market-data-refresh',
        },
        { merge: true },
      );
  }

  return {
    statusCode: failed.length ? 207 : 200,
    payload: {
      ok: failed.length === 0,
      collection,
      updated,
      failed,
      refreshedAt,
      universeCount: symbols.length,
      source: updated.every((item) => item.source === 'YAHOO_CHART_QUOTE_VERCEL')
        ? 'yahoo-finance-chart-quote'
        : 'yahoo-finance-chart-with-optional-quote',
      storage: useGitHubStorage ? 'github-public-repository' : 'firebase-firestore',
      transport: 'vercel-relay',
      ...(github ? { github } : {}),
      requestId,
    },
  };
}

async function buildGitHubMarketDataResponse({
  snapshot,
  state,
  requestId,
  cacheHit,
  updated,
  failed,
  warnings,
}) {
  const data = snapshot?.data || [];
  if (!data.length) {
    throw new RelayError(
      503,
      'MARKET_DATA_EMPTY',
      'GitHub market-data snapshot does not contain market data.',
    );
  }

  const checkedAt = new Date().toISOString();
  const timestamps = data
    .map((row) => readIsoTimestamp(row.fetchedAt || row.fetched_at || row.updatedAt || row.updated_at))
    .filter(Boolean)
    .sort();
  const lastRefreshAt = readIsoTimestamp(state.lastRefreshAt);
  const newestSnapshotAt = timestamps.at(-1) || null;
  const oldestSnapshotAt = timestamps[0] || null;
  const cacheAgeSeconds = lastRefreshAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(lastRefreshAt)) / 1000))
    : null;

  return {
    statusCode: failed.length ? 207 : 200,
    payload: {
      ok: failed.length === 0,
      collection: 'market_data',
      data,
      totalDocuments: data.length,
      updated,
      updatedSymbols: updated.map((item) => item.symbol),
      failed,
      source: 'github-public-snapshot',
      storage: 'github-public-repository',
      transport: 'vercel-relay',
      snapshotFile: snapshot.file,
      cache: {
        hit: cacheHit,
        windowSeconds: freshnessWindowMs / 1000,
        lastRefreshAt,
        ageSeconds: cacheAgeSeconds,
        isFresh: cacheAgeSeconds !== null && cacheAgeSeconds < freshnessWindowMs / 1000,
      },
      snapshotRange: {
        newestAt: newestSnapshotAt,
        oldestAt: oldestSnapshotAt,
        maxAgeSeconds: oldestSnapshotAt
          ? Math.max(0, Math.floor((Date.now() - Date.parse(oldestSnapshotAt)) / 1000))
          : null,
      },
      checkedAt,
      warnings,
      requestId,
    },
  };
}

async function buildMarketDataResponse({
  firestore,
  collection,
  state,
  requestId,
  cacheHit,
  updated,
  failed,
  warnings,
}) {
  const snapshot = await firestore.collection(collection).get();
  const checkedAt = new Date().toISOString();
  const orderedDocuments = [...snapshot.docs]
    .sort((left, right) => left.id.localeCompare(right.id));
  const limitedDocuments = orderedDocuments.slice(0, maximumUniverseSymbols);
  const data = limitedDocuments.map((document) => ({
    ...document.data(),
    symbol: document.data().symbol || document.id,
  }));
  if (!data.length) {
    throw new RelayError(
      503,
      'MARKET_DATA_EMPTY',
      `Firestore collection ${collection} does not contain market data.`,
    );
  }

  const timestamps = data
    .map((row) => readIsoTimestamp(row.fetchedAt || row.fetched_at || row.updatedAt || row.updated_at))
    .filter(Boolean)
    .sort();
  const lastRefreshAt = readIsoTimestamp(state.lastRefreshAt);
  const newestSnapshotAt = timestamps.at(-1) || null;
  const oldestSnapshotAt = timestamps[0] || null;
  const cacheAgeSeconds = lastRefreshAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(lastRefreshAt)) / 1000))
    : null;

  return {
    statusCode: failed.length ? 207 : 200,
    payload: {
      ok: failed.length === 0,
      collection,
      data,
      totalDocuments: data.length,
      updated,
      updatedSymbols: updated.map((item) => item.symbol),
      failed,
      source: 'firebase-admin',
      storage: 'firebase-firestore',
      transport: 'vercel-relay',
      cache: {
        hit: cacheHit,
        windowSeconds: freshnessWindowMs / 1000,
        lastRefreshAt,
        ageSeconds: cacheAgeSeconds,
        isFresh: cacheAgeSeconds !== null && cacheAgeSeconds < freshnessWindowMs / 1000,
      },
      snapshotRange: {
        newestAt: newestSnapshotAt,
        oldestAt: oldestSnapshotAt,
        maxAgeSeconds: oldestSnapshotAt
          ? Math.max(0, Math.floor((Date.now() - Date.parse(oldestSnapshotAt)) / 1000))
          : null,
      },
      checkedAt,
      warnings: [
        ...warnings,
        ...(orderedDocuments.length > maximumUniverseSymbols
          ? [`Firestore contains ${orderedDocuments.length} market_data documents; this response is limited to the first ${maximumUniverseSymbols} symbols.`]
          : []),
      ],
      requestId,
    },
  };
}

async function acquireRefreshLock(stateReference, requestId, { forceRefresh }) {
  const result = { acquired: false, fresh: false, state: {} };
  const now = Date.now();
  await getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(stateReference);
    const state = snapshot.exists ? snapshot.data() || {} : {};
    result.state = state;
    if (!forceRefresh && isFreshState(state)) {
      result.fresh = true;
      return;
    }

    const lockExpiresAt = readDate(state.lockExpiresAt);
    if (state.lockId && lockExpiresAt && lockExpiresAt.getTime() > now) {
      return;
    }

    result.acquired = true;
    transaction.set(
      stateReference,
      {
        lockId: requestId,
        lockExpiresAt: new Date(now + refreshLockLeaseMs).toISOString(),
        lastRefreshAttemptAt: new Date(now).toISOString(),
      },
      { merge: true },
    );
  });
  return result;
}

async function releaseRefreshLock(stateReference, requestId) {
  await getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(stateReference);
    const state = snapshot.exists ? snapshot.data() || {} : {};
    if (state.lockId !== requestId) return;
    transaction.set(
      stateReference,
      { lockId: null, lockExpiresAt: null },
      { merge: true },
    );
  });
}

async function waitForFreshState(stateReference) {
  const deadline = Date.now() + refreshWaitTimeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await stateReference.get();
    const state = snapshot.exists ? snapshot.data() || {} : {};
    if (isFreshState(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

function isFreshState(state) {
  const lastRefreshAt = readDate(state.lastRefreshAt);
  return Boolean(
    lastRefreshAt &&
      Date.now() - lastRefreshAt.getTime() >= 0 &&
      Date.now() - lastRefreshAt.getTime() < freshnessWindowMs,
  );
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function buildMarketSnapshot(symbol) {
  const [chartPayload, quotePayload] = await Promise.all([
    fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d&events=div%2Csplits`),
    fetchJson(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`).catch(() => null),
  ]);

  const chartResult = chartPayload?.chart?.result?.[0];
  if (!chartResult) {
    throw new RelayError(
      422,
      'MARKET_SYMBOL_NOT_AVAILABLE',
      `No market snapshot is available for ${symbol}.`,
    );
  }

  const meta = chartResult.meta || {};
  const quote = quotePayload?.quoteResponse?.result?.[0] || {};
  const quoteAvailable = Object.keys(quote).length > 0;
  const history = normaliseHistory(chartResult);
  const historyLatestClose = history.at(-1)?.close || 0;
  const historyPreviousClose = history.length >= 2 ? history[history.length - 2].close : 0;
  const latestClose = readPositiveNumber(
    quote.regularMarketPrice,
    meta.regularMarketPrice,
    historyLatestClose,
  );
  const previousClose = readPositiveNumber(
    historyPreviousClose,
    quote.regularMarketPreviousClose,
    meta.chartPreviousClose,
  );
  if (latestClose <= 0 || !history.length) {
    throw new RelayError(
      502,
      'MARKET_DATA_INCOMPLETE',
      `Market provider returned an incomplete snapshot for ${symbol}.`,
    );
  }
  const analytics = deriveAnalytics(history, latestClose);

  return {
    symbol,
    name: cleanText(quote.longName || quote.shortName || meta.longName || meta.shortName, symbol),
    currency: cleanText(quote.currency || meta.currency, 'USD'),
    exchange: cleanText(quote.fullExchangeName || meta.fullExchangeName || meta.exchangeName, ''),
    regularMarketPrice: latestClose,
    regularMarketPreviousClose: previousClose,
    regularMarketChange: latestClose - previousClose,
    regularMarketChangePercent: previousClose > 0 ? ((latestClose - previousClose) / previousClose) * 100 : 0,
    regularMarketOpen: readNumber(quote.regularMarketOpen, meta.regularMarketOpen),
    regularMarketDayLow: readNumber(quote.regularMarketDayLow, meta.regularMarketDayLow),
    regularMarketDayHigh: readNumber(quote.regularMarketDayHigh, meta.regularMarketDayHigh),
    regularMarketVolume: readNumber(quote.regularMarketVolume, meta.regularMarketVolume, history.at(-1)?.volume),
    marketCap: readNumber(quote.marketCap),
    trailingPE: readNumber(quote.trailingPE),
    forwardPE: readNumber(quote.forwardPE),
    dividendYield: normaliseDividendYield(readNumber(quote.trailingAnnualDividendYield, quote.dividendYield)),
    beta: readNullableNumber(quote.beta),
    fiftyTwoWeekLow: readNumber(quote.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: readNumber(quote.fiftyTwoWeekHigh),
    sector: cleanText(quote.sector, 'general'),
    history,
    analytics,
    source: quoteAvailable ? 'YAHOO_CHART_QUOTE_VERCEL' : 'YAHOO_CHART_VERCEL',
    provider: quoteAvailable ? 'yahoo-finance-chart-quote' : 'yahoo-finance-chart',
    fetchedAt: new Date().toISOString(),
    researchOnly: true,
  };
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'StockAI coursework market data refresh',
      },
      signal: AbortSignal.timeout(7_000),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new RelayError(504, 'MARKET_PROVIDER_TIMEOUT', 'Market-data provider timed out.');
    }
    throw new RelayError(502, 'MARKET_PROVIDER_UNAVAILABLE', 'Market-data provider is unavailable.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) {
      throw new RelayError(429, 'MARKET_PROVIDER_RATE_LIMITED', 'Market-data provider is rate limited.');
    }
    if (response.status === 404) {
      throw new RelayError(422, 'MARKET_SYMBOL_NOT_AVAILABLE', 'Market symbol is not available.');
    }
    if (response.status === 408 || response.status === 504) {
      throw new RelayError(504, 'MARKET_PROVIDER_TIMEOUT', 'Market-data provider timed out.');
    }
    throw new RelayError(502, 'MARKET_PROVIDER_ERROR', 'Market-data provider returned an error.');
  }
  return payload;
}

function normaliseHistory(chartResult) {
  const timestamps = chartResult.timestamp || [];
  const quote = chartResult.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const volumes = quote.volume || [];
  const rows = [];

  for (let index = 0; index < timestamps.length; index += 1) {
    const close = readNumber(closes[index]);
    if (close <= 0) {
      continue;
    }
    rows.push({
      date: new Date(timestamps[index] * 1000).toISOString().slice(0, 10),
      close,
      open: readNumber(opens[index], close),
      high: readNumber(highs[index], close),
      low: readNumber(lows[index], close),
      volume: readNumber(volumes[index]),
    });
  }

  const withIndicators = rows.map((row, index) => {
    const previous = index > 0 ? rows[index - 1].close : 0;
    return {
      ...row,
      daily_return: previous > 0 ? ((row.close - previous) / previous) * 100 : 0,
      ma5: movingAverage(rows, index, 5),
      ma20: movingAverage(rows, index, 20),
      ma50: movingAverage(rows, index, 50),
      volume_ma20: volumeAverage(rows, index, 20),
    };
  });

  return withIndicators.slice(-130);
}

function deriveAnalytics(history, latestClose) {
  const closes = history.map((item) => item.close).filter((value) => value > 0);
  const volumes = history.map((item) => item.volume).filter((value) => value > 0);
  const latest = latestClose > 0 ? latestClose : closes.at(-1) || 0;
  const ma20 = history.at(-1)?.ma20 || movingAverage(history, history.length - 1, 20);
  const ma50 = history.at(-1)?.ma50 || movingAverage(history, history.length - 1, 50);
  return {
    return_30d: periodReturn(closes, latest, 30),
    return_90d: periodReturn(closes, latest, 90),
    volatility_30d: volatility(closes, 30),
    average_volume_30d: average(volumes.slice(-30)),
    max_drawdown: maxDrawdown(closes),
    rsi14: rsi(closes, 14),
    moving_average_20d: ma20,
    moving_average_50d: ma50,
    price_vs_ma20_pct: ma20 > 0 ? ((latest - ma20) / ma20) * 100 : 0,
  };
}

function periodReturn(closes, latest, lookbackDays) {
  if (closes.length < 2 || latest <= 0) return 0;
  const index = closes.length > lookbackDays ? closes.length - lookbackDays - 1 : 0;
  const base = closes[index];
  return base > 0 ? ((latest - base) / base) * 100 : 0;
}

function volatility(closes, lookbackDays) {
  const start = closes.length > lookbackDays ? closes.length - lookbackDays : 1;
  const returns = [];
  for (let index = start; index < closes.length; index += 1) {
    const previous = closes[index - 1];
    if (previous > 0) returns.push(((closes[index] - previous) / previous) * 100);
  }
  if (returns.length < 2) return 0;
  const mean = average(returns);
  const variance = returns.reduce((total, value) => total + ((value - mean) ** 2), 0) / (returns.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function maxDrawdown(closes) {
  let peak = closes[0] || 0;
  let worst = 0;
  for (const close of closes.slice(1)) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const drawdown = ((close - peak) / peak) * 100;
      if (drawdown < worst) worst = drawdown;
    }
  }
  return worst;
}

function rsi(closes, period) {
  if (closes.length <= period) return 0;
  let gains = 0;
  let losses = 0;
  for (let index = closes.length - period; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const relativeStrength = gains / losses;
  return 100 - (100 / (1 + relativeStrength));
}

function movingAverage(rows, index, period) {
  if (index < 0) return 0;
  const start = Math.max(0, index - period + 1);
  return average(rows.slice(start, index + 1).map((row) => row.close).filter((value) => value > 0));
}

function volumeAverage(rows, index, period) {
  if (index < 0) return 0;
  const start = Math.max(0, index - period + 1);
  return average(rows.slice(start, index + 1).map((row) => row.volume).filter((value) => value > 0));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

async function resolveRefreshSymbols(value, collectionReference, existingSnapshotData = undefined) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    const configuredSymbols = String(
      process.env.STOCKAI_MARKET_SYMBOLS || process.env.STOCKAI_MARKET_UNIVERSE || '',
    )
      .split(',')
      .map((symbol) => symbol.trim())
      .filter(Boolean);
    if (configuredSymbols.length) return normaliseSymbols(configuredSymbols);

    const snapshotSymbols = Array.isArray(existingSnapshotData)
      ? existingSnapshotData.map((item) => item?.symbol)
      : [];
    if (snapshotSymbols.length) return normaliseSymbols(snapshotSymbols);

    if (!collectionReference) {
      throw new RelayError(
        503,
        'MARKET_UNIVERSE_NOT_CONFIGURED',
        'Configure STOCKAI_MARKET_SYMBOLS before the first GitHub market-data refresh.',
      );
    }
    const documents = await collectionReference.listDocuments();
    const symbols = normaliseSymbols(documents.map((document) => document.id));
    if (!symbols.length) {
      throw new RelayError(
        503,
        'MARKET_UNIVERSE_EMPTY',
        'Firestore market_data does not contain a stock universe to refresh.',
      );
    }
    return symbols;
  }
  if (!Array.isArray(value)) {
    throw new RelayError(400, 'INVALID_SYMBOLS', 'symbols must be an array.');
  }
  return normaliseSymbols(value);
}

function normaliseSymbols(symbols) {
  const boundedSymbols = [...symbols]
    .sort((left, right) => String(left).localeCompare(String(right)))
    .slice(0, maximumUniverseSymbols);
  const normalised = [];
  const seen = new Set();
  for (const item of boundedSymbols) {
    const symbol = sanitiseSymbol(item);
    if (!symbol) {
      throw new RelayError(400, 'INVALID_SYMBOL', 'symbols contains an invalid ticker symbol.');
    }
    if (!seen.has(symbol)) {
      seen.add(symbol);
      normalised.push(symbol);
    }
  }
  return normalised;
}

function readDate(value) {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value);
  }
  return null;
}

function readIsoTimestamp(value) {
  const date = readDate(value);
  return date ? date.toISOString() : null;
}

function sanitiseSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return '';
  return symbol;
}

function sanitiseCollectionName(value) {
  const name = String(value || defaultCollection).trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(name)) {
    throw new RelayError(
      503,
      'FIREBASE_COLLECTION_NOT_CONFIGURED',
      'Firebase market-data collection is not configured correctly.',
    );
  }
  return name;
}

function readNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function readPositiveNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function readNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normaliseDividendYield(value) {
  if (value >= 0.2) return value / 100;
  return value;
}

function cleanText(value, fallback, maxLength = 160) {
  const text = String(value ?? fallback)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return text || fallback;
}
