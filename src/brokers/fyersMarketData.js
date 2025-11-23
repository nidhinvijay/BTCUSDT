// src/brokers/fyersMarketData.js
import axios from 'axios';

export class FyersMarketData {
  constructor({ accessToken, logger }) {
    this.accessToken = accessToken;
    this.logger = logger;
    this.baseUrl = 'https://api-t1.fyers.in/data-rest/v3'; // Updated to v3
  }

  // Get current market quotes
  async getQuotes(symbols) {
    try {
      const symbolString = symbols.join(',');
      const response = await axios.get(`${this.baseUrl}/quotes/`, {
        headers: {
          Authorization: `${this.accessToken}`,
        },
        params: {
          symbols: symbolString,
        },
      });

      if (response.data.s === 'ok') {
        return response.data.d;
      } else {
        throw new Error(`Fyers API error: ${response.data.message || 'Unknown error'}`);
      }
    } catch (error) {
      this.logger.error({ error: error.message, symbols }, 'Failed to get Fyers quotes');
      throw error;
    }
  }

  // Get historical data
  async getHistory({ symbol, resolution, dateFrom, dateTo }) {
    try {
      const response = await axios.get(`${this.baseUrl}/history/`, {
        headers: {
          Authorization: `${this.accessToken}`,
        },
        params: {
          symbol,
          resolution,
          date_format: '1',
          range_from: dateFrom,
          range_to: dateTo,
        },
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
      const response = await axios.get(`${this.baseUrl}/depth/`, {
        headers: {
          Authorization: `${this.accessToken}`,
        },
        params: {
          symbol,
          ohlcv_flag: '1',
        },
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
