# StockAI Vercel Relay

Server-side relay used by the StockAI Advisor Web and Flutter app. It keeps Gemini
and Firebase Admin credentials outside browser/mobile bundles and exposes five
research-only endpoints:

| Endpoint | Purpose | Maximum JSON body |
|---|---|---:|
| `POST /api/query-parse` | Gemini structured stock-search intent | 16 KiB |
| `POST /api/gemini-stock-insight` | Gemini research explanation | 64 KiB |
| `POST /api/account-sync` | Firebase Admin account-snapshot write | 256 KiB |
| `POST /api/market-data-refresh` | 30-minute market-data cache, full Yahoo refresh when stale, and complete snapshot response | 8 KiB |
| `GET /api/cron/market-data-refresh` | Scheduled Yahoo refresh into the configured storage | N/A |

The four POST endpoints also support `OPTIONS`; the Cron endpoint accepts `GET`
only. Any unsupported method returns `405`, and non-JSON POST requests return
`415`.

## Security and browser policy

Every POST requires `x-stockai-demo-token`. Configure a shared
`STOCKAI_RELAY_TOKEN`, or use a per-endpoint override:

```text
STOCKAI_QUERY_TOKEN
STOCKAI_INSIGHT_TOKEN
STOCKAI_SYNC_TOKEN
STOCKAI_MARKET_TOKEN
```

An optional `STOCKAI_WEB_BFF_TOKEN` adds a second accepted server-only token
for the deployed web BFF without replacing the Flutter/Remote Config token.

An unconfigured token is a server configuration failure (`503`), not public
anonymous access. Tokens are compared with a timing-safe comparison.

The scheduled endpoint is server-to-server only. Vercel supplies
`Authorization: Bearer <CRON_SECRET>`, which is checked with the same timing-safe
comparison before Firebase is accessed.

Same-origin browser calls are accepted automatically. Cross-origin browser calls
must match `STOCKAI_ALLOWED_ORIGINS` (comma separated); an omitted allow-list no
longer becomes wildcard CORS. Native Flutter and server-to-server calls without an
`Origin` header remain valid. `*` is supported only when explicitly configured for
an intentional demo.

Every response has `Cache-Control: no-store`, an `x-request-id` header, and the
same `requestId` in JSON success/error bodies. A valid inbound `x-request-id` is
preserved so a same-origin BFF can correlate the complete request path.

## Gemini model policy and provenance

The server chooses `GEMINI_QUERY_MODEL` / `GEMINI_INSIGHT_MODEL`, falling back to
`GEMINI_MODEL` and then `gemini-3.5-flash`. A client may request a model only when
it is present in `GEMINI_ALLOWED_MODELS` or the endpoint-specific allow-list. The
legacy Flutter value `gemini-3-flash-preview` maps to the configured server model.
Arbitrary client model names return `400 MODEL_NOT_ALLOWED`.

Successful Gemini responses retain the existing client fields and add explicit
provenance:

```json
{
  "source": "gemini",
  "provider": "google-generative-language",
  "transport": "vercel-relay",
  "model": "gemini-3.5-flash",
  "configuredModel": "gemini-3.5-flash",
  "requestId": "..."
}
```

The query endpoint still returns the exact Flutter `ParsedQuery` fields:
`symbols`, `keywords`, `riskProfile`, `incomeFocus`, `maxPrice`,
`sectorPreference`, `maxPe`, `lowBetaFocus`, `largeCapFocus`, and `valueFocus`.
Only a successful Gemini parse returns `source: "gemini"`; clients retain their
labelled deterministic fallback for every non-2xx result.

The insight prompt treats stock/profile values as data, prohibits personalised
advice and buy/sell/hold instructions, and bounds stock history/reason strings
before they reach Gemini.

## Firebase contracts

`/api/account-sync` requires the top-level `accountId` to equal
`snapshot.account.id`. Limits are 60 watchlist symbols, 60 watchlist stock objects,
80 saved screens, and 80 alert rules. The relay derives the count summary instead
of trusting client counts and returns/stores a canonical SHA-256 `snapshotDigest`.
This confirms one authenticated relay write; it is not Firebase Auth or proof of
cross-device restore.

`/api/market-data-refresh` is the single market-data read path for Web and
Flutter. With the default `STOCKAI_MARKET_DATA_STORAGE=firestore`, it uses the
`market_data_meta/refresh_state` document as a 30-minute server-side freshness
record. Set `STOCKAI_MARKET_DATA_STORAGE=github` to use the public
`STOCKAI_GITHUB_REPOSITORY` instead: the relay reads `STOCKAI_GITHUB_PATH`, and
each scheduled full-universe refresh publishes one `market-data.json` commit
through the GitHub Contents API. In GitHub mode the browser only reads the
published snapshot and does not access Firestore at all. The optional `symbols`
request field is only a small compatibility hint; it does not reduce a cron
full-universe refresh. A `207` response can contain fresh successful writes and
retained previous snapshots for failed symbols. Missing beta remains `null`; the
relay does not fabricate beta `1.0`.

`/api/cron/market-data-refresh` reuses the same full-universe write pipeline.
`vercel.json` schedules it at `0 16 * * *` UTC, which is 00:00 in
`Asia/Hong_Kong`; request-time freshness protection still prevents repeated
refreshes inside the 30-minute window.

## Error contract

Configuration problems return `503`, validation/auth/origin problems use their
corresponding `4xx`, provider failures use `502`/`504`, and provider rate limiting
uses `429`. Provider payloads, credentials, and internal exception text are never
echoed to clients.

`query-parse` retains the evaluator-compatible structured envelope:

```json
{ "error": { "code": "MODEL_NOT_ALLOWED", "message": "..." }, "requestId": "..." }
```

The other four endpoints retain their string `error` field for current Web
and Flutter consumers and add stable `errorCode` plus `requestId`.

## GitHub snapshot configuration

When GitHub snapshot storage is enabled, add these Vercel server-only variables
and grant the fine-grained token `Contents: Read and write` on the snapshot repo:

```text
STOCKAI_MARKET_DATA_STORAGE=github
STOCKAI_GITHUB_TOKEN=<fine-grained GitHub token>
STOCKAI_GITHUB_REPOSITORY=25024744-JimmyLee/stockai-market-snapshot
STOCKAI_GITHUB_BRANCH=main
STOCKAI_GITHUB_PATH=market-data.json
STOCKAI_MARKET_SYMBOLS=AAPL,MSFT,GOOGL,...
```

The token stays server-side and is never written to the public JSON. The first
refresh needs `STOCKAI_MARKET_SYMBOLS`; later refreshes can reuse symbols from
the existing snapshot.

## Configuration

Copy `.env.example` into Vercel environment settings and replace every placeholder.
Do not commit real credentials. Required service variables are:

```text
GEMINI_API_KEY
STOCKAI_RELAY_TOKEN (or every endpoint-specific token)
CRON_SECRET
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
```

Optional Firestore collection overrides:

```text
FIREBASE_ACCOUNT_SYNC_COLLECTION=mobile_account_sync
FIREBASE_MARKET_DATA_COLLECTION=market_data
```

## Local contract check

The checker exercises method, CORS, relay/Cron authentication, request-size,
model, identity, and collection-count boundaries without live Gemini/Firebase
calls or real secrets:

```powershell
cd vercel-gemini-relay
npm install
npm run check
npm run contract:check
```

For local Vercel execution or an authorised deployment:

```powershell
npx vercel dev
npx vercel --prod
```

Production deployment remains a separate authorised operation; the repository
does not contain deployment credentials.
