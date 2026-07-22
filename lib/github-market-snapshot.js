import { RelayError } from './relay-http.js';

const githubApiBaseUrl = 'https://api.github.com';
const defaultRepository = '25024744-JimmyLee/stockai-market-snapshot';
const defaultBranch = 'main';
const defaultPath = 'market-data.json';
const maximumSnapshotBytes = 15 * 1024 * 1024;
const symbolPattern = /^[A-Z][A-Z0-9.-]{0,9}$/;

export function isGitHubMarketStorage() {
  return String(process.env.STOCKAI_MARKET_DATA_STORAGE || '').trim().toLowerCase() === 'github';
}

export function getGitHubSnapshotConfig() {
  const token = readEnv('STOCKAI_GITHUB_TOKEN') || readEnv('GITHUB_TOKEN');
  if (!token) {
    throw new RelayError(
      503,
      'GITHUB_TOKEN_NOT_CONFIGURED',
      'GitHub market-data token is not configured.',
    );
  }

  const repository = readEnv('STOCKAI_GITHUB_REPOSITORY') || defaultRepository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new RelayError(
      503,
      'GITHUB_REPOSITORY_NOT_CONFIGURED',
      'GitHub market-data repository is not configured correctly.',
    );
  }

  const branch = readEnv('STOCKAI_GITHUB_BRANCH') || defaultBranch;
  const path = readEnv('STOCKAI_GITHUB_PATH') || defaultPath;
  if (!/^[^\0]+$/.test(path) || path.startsWith('/') || path.endsWith('/')) {
    throw new RelayError(
      503,
      'GITHUB_PATH_NOT_CONFIGURED',
      'GitHub market-data path is not configured correctly.',
    );
  }

  return { token, repository, branch, path };
}

export function publicGitHubSnapshotConfig(config = getGitHubSnapshotConfig()) {
  return {
    repository: config.repository,
    branch: config.branch,
    path: config.path,
  };
}

export async function readGitHubMarketSnapshot({ allowMissing = false } = {}) {
  const config = getGitHubSnapshotConfig();
  const file = await readGitHubFile(config, { allowMissing });
  if (!file) return null;

  const text = decodeContent(file.content);
  if (Buffer.byteLength(text, 'utf8') > maximumSnapshotBytes) {
    throw new RelayError(
      502,
      'GITHUB_SNAPSHOT_TOO_LARGE',
      'GitHub market-data snapshot is too large to process.',
    );
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new RelayError(
      502,
      'GITHUB_SNAPSHOT_INVALID_JSON',
      'GitHub market-data snapshot is not valid JSON.',
    );
  }

  const data = normaliseSnapshotData(document?.data);
  if (!data.length) {
    throw new RelayError(
      503,
      'GITHUB_SNAPSHOT_EMPTY',
      'GitHub market-data snapshot does not contain market data.',
    );
  }

  return {
    data,
    generatedAt: readIsoTimestamp(document.generatedAt || document.lastRefreshAt),
    lastRefreshAt: readIsoTimestamp(document.lastRefreshAt || document.generatedAt),
    updatedSymbols: normaliseOptionalSymbols(document.updatedSymbols),
    failed: Array.isArray(document.failed) ? document.failed.slice(0, 200) : [],
    file: {
      sha: typeof file.sha === 'string' ? file.sha : null,
      commitSha: typeof file.commit?.sha === 'string' ? file.commit.sha : null,
      htmlUrl: typeof file.html_url === 'string' ? file.html_url : null,
      ...publicGitHubSnapshotConfig(config),
    },
  };
}

export async function writeGitHubMarketSnapshot({
  data,
  generatedAt,
  updatedSymbols = [],
  failed = [],
}) {
  const config = getGitHubSnapshotConfig();
  const safeData = normaliseSnapshotData(data);
  if (!safeData.length) {
    throw new RelayError(
      422,
      'GITHUB_SNAPSHOT_EMPTY',
      'Cannot publish an empty GitHub market-data snapshot.',
    );
  }

  const timestamp = readIsoTimestamp(generatedAt) || new Date().toISOString();
  const document = {
    schemaVersion: 1,
    generatedAt: timestamp,
    lastRefreshAt: timestamp,
    source: 'vercel-market-data-refresh',
    provider: 'yahoo-finance-chart-quote-or-chart',
    storage: 'github-public-repository',
    ...publicGitHubSnapshotConfig(config),
    totalDocuments: safeData.length,
    updatedSymbols: normaliseOptionalSymbols(updatedSymbols),
    failed: Array.isArray(failed) ? failed.slice(0, 200) : [],
    data: safeData,
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > maximumSnapshotBytes) {
    throw new RelayError(
      422,
      'GITHUB_SNAPSHOT_TOO_LARGE',
      'The generated market-data snapshot is too large for the public repository.',
    );
  }

  let lastConflict = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let branchState = null;
      try {
        branchState = await readGitHubBranchState(config);
      } catch (error) {
        if (!(error instanceof RelayError) || error.code !== 'GITHUB_SNAPSHOT_NOT_FOUND') throw error;
      }
      const blob = await requestGitHub(config, 'POST', githubGitBlobsPath(config), {
        content: Buffer.from(text, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      const tree = await requestGitHub(config, 'POST', githubGitTreesPath(config), {
        ...(branchState?.treeSha ? { base_tree: branchState.treeSha } : {}),
        tree: [{
          path: config.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        }],
      });
      const commit = await requestGitHub(config, 'POST', githubGitCommitsPath(config), {
        message: `chore: refresh market data snapshot (${safeData.length} symbols)`,
        tree: tree.sha,
        parents: branchState?.commitSha ? [branchState.commitSha] : [],
      });
      if (branchState) {
        await requestGitHub(config, 'PATCH', githubGitRefPath(config), {
          sha: commit.sha,
          force: false,
        });
      } else {
        await requestGitHub(config, 'POST', githubGitRefsPath(config), {
          ref: `refs/heads/${config.branch}`,
          sha: commit.sha,
        });
      }
      return {
        ...publicGitHubSnapshotConfig(config),
        commitSha: typeof commit.sha === 'string' ? commit.sha : null,
        commitUrl: typeof commit.html_url === 'string' ? commit.html_url : null,
        fileUrl: githubFileUrl(config),
      };
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== 'GITHUB_SNAPSHOT_CONFLICT') throw error;
      lastConflict = error;
    }
  }
  throw lastConflict || new RelayError(
    409,
    'GITHUB_SNAPSHOT_CONFLICT',
    'GitHub market-data snapshot changed while it was being published.',
  );
}

export function normaliseSnapshotData(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const symbol = String(item.symbol || '').trim().toUpperCase();
    if (!symbolPattern.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    result.push({ ...item, symbol });
  }
  return result.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function normaliseOptionalSymbols(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((symbol, index, symbols) => symbolPattern.test(symbol) && symbols.indexOf(symbol) === index)
    .slice(0, 200);
}

async function readGitHubFile(config, { allowMissing }) {
  try {
    const branchState = await readGitHubBranchState(config);
    const tree = await requestGitHub(
      config,
      'GET',
      `${githubGitTreesPath(config, branchState.treeSha)}?recursive=1`,
    );
    const entry = Array.isArray(tree.tree)
      ? tree.tree.find((item) => item?.type === 'blob' && item.path === config.path)
      : null;
    if (!entry?.sha) {
      if (allowMissing) return null;
      throw new RelayError(404, 'GITHUB_SNAPSHOT_NOT_FOUND', 'GitHub market-data snapshot was not found.');
    }
    const blob = await requestGitHub(config, 'GET', githubGitBlobsPath(config, entry.sha));
    return {
      content: blob.content,
      sha: entry.sha,
      commit: { sha: branchState.commitSha },
      html_url: githubFileUrl(config),
    };
  } catch (error) {
    if (allowMissing && error instanceof RelayError && error.code === 'GITHUB_SNAPSHOT_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

async function readGitHubBranchState(config) {
  const reference = await requestGitHub(config, 'GET', githubGitRefPath(config));
  const commitSha = typeof reference.object?.sha === 'string' ? reference.object.sha : null;
  if (!commitSha) {
    throw new RelayError(502, 'GITHUB_BRANCH_INVALID', 'GitHub market-data branch head is unavailable.');
  }

  const commit = await requestGitHub(config, 'GET', githubGitCommitsPath(config, commitSha));
  const treeSha = typeof commit.tree?.sha === 'string' ? commit.tree.sha : null;
  if (!treeSha) {
    throw new RelayError(502, 'GITHUB_TREE_INVALID', 'GitHub market-data tree is unavailable.');
  }
  return { commitSha, treeSha };
}

async function requestGitHub(config, method, path, body = undefined) {
  let response;
  try {
    response = await fetch(`${githubApiBaseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${config.token}`,
        'user-agent': 'StockAI Vercel market-data relay',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new RelayError(504, 'GITHUB_REQUEST_TIMEOUT', 'GitHub request timed out.');
    }
    throw new RelayError(502, 'GITHUB_UNAVAILABLE', 'GitHub is unavailable.');
  }

  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload;

  if (response.status === 404) {
    throw new RelayError(404, 'GITHUB_SNAPSHOT_NOT_FOUND', 'GitHub market-data snapshot was not found.');
  }
  if (response.status === 401) {
    throw new RelayError(503, 'GITHUB_TOKEN_INVALID', 'GitHub market-data token was rejected.');
  }
  if (response.status === 403) {
    throw new RelayError(503, 'GITHUB_PERMISSION_DENIED', 'GitHub denied market-data repository access.');
  }
  if (response.status === 409 && payload.message === 'Git Repository is empty.') {
    throw new RelayError(404, 'GITHUB_SNAPSHOT_NOT_FOUND', 'GitHub market-data snapshot was not found.');
  }
  if (response.status === 409) {
    throw new RelayError(409, 'GITHUB_SNAPSHOT_CONFLICT', 'GitHub market-data snapshot changed during the update.');
  }
  if (response.status === 429) {
    throw new RelayError(429, 'GITHUB_RATE_LIMITED', 'GitHub API is temporarily rate limited.');
  }
  throw new RelayError(
    response.status >= 500 ? 502 : 503,
    'GITHUB_REQUEST_FAILED',
    'GitHub could not complete the market-data request.',
  );
}

function githubGitRefPath(config) {
  const encodedBranch = config.branch.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/repos/${config.repository}/git/ref/heads/${encodedBranch}`;
}

function githubGitRefsPath(config) {
  return `/repos/${config.repository}/git/refs`;
}

function githubGitBlobsPath(config, sha = '') {
  return sha
    ? `/repos/${config.repository}/git/blobs/${encodeURIComponent(sha)}`
    : `/repos/${config.repository}/git/blobs`;
}

function githubGitTreesPath(config, sha = '') {
  return sha
    ? `/repos/${config.repository}/git/trees/${encodeURIComponent(sha)}`
    : `/repos/${config.repository}/git/trees`;
}

function githubGitCommitsPath(config, sha = '') {
  return sha
    ? `/repos/${config.repository}/git/commits/${encodeURIComponent(sha)}`
    : `/repos/${config.repository}/git/commits`;
}

function githubFileUrl(config) {
  const encodedBranch = config.branch.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const encodedPath = config.path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `https://github.com/${config.repository}/blob/${encodedBranch}/${encodedPath}`;
}

function decodeContent(content) {
  if (typeof content !== 'string') {
    throw new RelayError(502, 'GITHUB_SNAPSHOT_INVALID_CONTENT', 'GitHub market-data file content is unavailable.');
  }
  try {
    return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    throw new RelayError(502, 'GITHUB_SNAPSHOT_INVALID_CONTENT', 'GitHub market-data file content is invalid.');
  }
}

function readIsoTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function readEnv(name) {
  return String(process.env[name] || '').trim();
}
