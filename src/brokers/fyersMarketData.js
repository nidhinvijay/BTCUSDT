// src/brokers/fyersMarketData.js
import axios from 'axios';

const DATA_BASES = [
  { version: 'v3', url: 'https://api-t1.fyers.in/data-rest/v3' },
  { version: 'v3', url: 'https://api.fyers.in/data-rest/v3' },
  { version: 'v3', url: 'https://myapi.fyers.in/data-rest/v3' },
  { version: 'v2', url: 'https://api-t1.fyers.in/data-rest/v2' },
  { version: 'v2', url: 'https://api.fyers.in/data-rest/v2' },
  { version: 'v2', url: 'https://myapi.fyers.in/data-rest/v2' }
];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  Referer: 'https://trade.fyers.in/'
};

export class FyersMarketData {
  constructor({ appId, accessToken, logger }) {
    this.appId = appId;
    this.accessToken = accessToken;
    this.logger = logger;
    this.preferredVersion = 'v3';
    this.baseTargets = this.orderBaseTargets(process.env.FYERS_DATA_VERSION);
    this.activeBaseIndex = 0;
    this.http = axios.create({ timeout: 8000 });
  }

  get authHeaders() {
    return {
      ...BROWSER_HEADERS,
      Authorization: `${this.appId}:${this.accessToken}`
    };
  }

  orderBaseTargets(preference) {
    const pref = (preference || 'v3').toLowerCase();
    if (pref !== 'v2' && pref !== 'v3' && pref !== 'auto') {
      this.logger.warn({ pref }, 'Unknown FYERS_DATA_VERSION, defaulting to v3');
    }
    const resolved = pref === 'v2' ? 'v2' : pref === 'auto' ? 'auto' : 'v3';
    this.preferredVersion = resolved;
    const prioritized =
      resolved === 'auto'
        ? DATA_BASES.slice()
        : [
            ...DATA_BASES.filter((b) => b.version === (resolved === 'v2' ? 'v2' : 'v3')),
            ...DATA_BASES.filter((b) => b.version !== (resolved === 'v2' ? 'v2' : 'v3')),
          ];
    return prioritized;
  }

  async request(path, params) {
    let lastError = null;
    for (let i = 0; i < this.baseTargets.length; i++) {
      const idx = (this.activeBaseIndex + i) % this.baseTargets.length;
      const baseTarget = this.baseTargets[idx];
      const base = baseTarget.url;
      try {
        const response = await this.http.get(`${base}${path}`, {
          headers: this.authHeaders,
          params
        });
        this.activeBaseIndex = idx;
        if (
          baseTarget.version === 'v2' &&
          path.includes('/quotes') &&
          this.preferredVersion !== 'v2'
        ) {
          this.logger.warn(
            { base },
            'Falling back to Fyers data v2 endpoint due to v3 unavailability'
          );
        }
        return response;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        const message = error.response?.data?.message;
        let bodySnippet = null;
        if (error.response?.data) {
          if (typeof error.response.data === 'string') {
            bodySnippet = error.response.data.slice(0, 200);
          } else {
            bodySnippet = JSON.stringify(error.response.data).slice(0, 200);
          }
        }
        this.logger.warn(
          { base, status, message, bodySnippet, version: baseTarget.version },
          'Fyers data API request failed'
        );
        if (i < this.baseTargets.length - 1) {
          continue; // try next base
        }
        throw error;
      }
    }
    throw lastError || new Error('Unknown Fyers data API error');
  }

  // Get current market quotes
  async getQuotes(symbols) {
    try {
      const symbolString = symbols.join(',');

      const response = await this.request('/quotes/', { symbols: symbolString });

      if (response.data.s !== 'ok') {
        throw new Error(response.data.message || 'Unknown error');
      }

      // API returns array [{ n: 'NSE:NIFTY50-INDEX', v: {...}}]
      const mapped = {};
      (response.data.d || []).forEach((item) => {
        if (item?.n) {
          mapped[item.n] = item;
        }
      });
      return mapped;
    } catch (error) {
      this.logger.error({ error: error.message, symbols }, 'Failed to get Fyers quotes');
      throw error;
    }
  }

  // Get historical data
  async getHistory({ symbol, resolution, dateFrom, dateTo }) {
    try {
      const response = await this.request('/history/', {
        symbol,
        resolution,
        date_format: '1',
        range_from: dateFrom,
        range_to: dateTo,
      });

      if (response.data.s === 'ok') {
        return response.data.candles;
      } else {
        throw new Error(`Fyers API error: ${response.data.message || 'Unknown error'}`);
      }
    } catch (error) {
      this.logger.error({ error: error.message, symbol }, 'Failed to get Fyers history');
      throw error;
    }
  }

  // Get market depth
  async getDepth(symbol) {
    try {
      const response = await this.request('/depth/', {
        symbol,
        ohlcv_flag: '1',
      });

      if (response.data.s === 'ok') {
        return response.data.d;
      } else {
        throw new Error(`Fyers API error: ${response.data.message || 'Unknown error'}`);
      }
    } catch (error) {
      this.logger.error({ error: error.message, symbol }, 'Failed to get Fyers depth');
      throw error;
    }
  }
}
