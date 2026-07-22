import { loadMarketData } from '../market-data-refresh.js';
import {
  RelayError,
  asRelayError,
  beginRequest,
  sendError,
} from '../../lib/relay-http.js';
import { requireCronSecret } from '../../lib/relay-security.js';

const schedule = '0 16 * * *';

export default async function handler(request, response) {
  const requestId = beginRequest(request, response);
  try {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      throw new RelayError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
    }

    requireCronSecret(request);
    const result = await loadMarketData(requestId, { forceRefresh: true });
    console.info(JSON.stringify({
      event: 'market_data_cron_refresh',
      outcome: result.statusCode === 200 ? 'success' : 'partial',
      statusCode: result.statusCode,
      updatedSymbols: result.payload.updatedSymbols,
      failed: result.payload.failed,
      requestId,
    }));
    response.status(result.statusCode).json({
      ...result.payload,
      trigger: 'vercel-cron',
      schedule: {
        cronUtc: schedule,
        timezone: 'Asia/Hong_Kong',
        localTime: '00:00',
      },
    });
  } catch (error) {
    const relayError = asRelayError(error);
    console.error(JSON.stringify({
      event: 'market_data_cron_refresh',
      outcome: 'failed',
      statusCode: relayError.status,
      errorCode: relayError.code,
      requestId,
    }));
    sendError(response, relayError, requestId, { legacyString: true });
  }
}
