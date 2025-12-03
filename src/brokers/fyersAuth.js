// src/brokers/fyersAuth.js
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TOKEN_FILE = path.resolve('data', 'fyers_token.json');
const TOKEN_EXPIRY_BUFFER_MS = 2 * 60 * 1000; // refresh at least 2 minutes early
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function decodeJwtExpiry(token, logger) {
  if (!token) return 0;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    if (typeof payload?.exp === 'number') {
      return payload.exp * 1000;
    }
  } catch (error) {
    logger?.warn?.({ error: error?.message || error }, 'Failed to decode FYERS token expiry');
  }
  return 0;
}

function nextIst9amUtc() {
  const now = new Date();
  const nowIST = new Date(now.getTime() + IST_OFFSET_MS);
  const next9AM = new Date(nowIST);
  next9AM.setHours(9, 0, 0, 0);
  if (nowIST.getHours() >= 9) {
    next9AM.setDate(next9AM.getDate() + 1);
  }
  return next9AM.getTime() - IST_OFFSET_MS;
}

function deriveExpiryUtc(accessToken, storedExpiry, logger) {
  const jwtExpiry = decodeJwtExpiry(accessToken, logger);
  const expiry = jwtExpiry || storedExpiry || nextIst9amUtc();
  if (!expiry) return 0;
  return Math.max(0, expiry - TOKEN_EXPIRY_BUFFER_MS);
}

export class FyersAuth {
  constructor({ appId, secretKey, redirectUri, pin, logger }) {
    this.appId = appId;
    this.secretKey = secretKey;
    this.redirectUri = redirectUri;
    this.pin = pin;
    this.logger = logger;
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this._refreshTimer = null;

    // Try to load existing token
    this.loadToken();
  }

  // Initialize: Check expiry and refresh if needed
  async initialize() {
    if (this.isAuthenticated()) {
      this._scheduleAutoRefresh();
      return true;
    }

    if (this.refreshToken) {
      this.logger.info('Access token expired, attempting refresh...');
      const ok = await this.refreshAccessToken();
      if (ok) this._scheduleAutoRefresh();
      return ok;
    }

    return false;
  }

  // Generate auth code URL (user needs to visit this) - API v3
  getAuthCodeUrl() {
    const state = crypto.randomBytes(16).toString('hex');
    // Updated to v3 endpoint
    const authUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${this.appId}&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code&state=${state}`;

    return { authUrl, state };
  }

  // Exchange auth code for access token - API v3
  async getAccessToken(authCode) {
    try {
      // V3 uses different hash algorithm
      const appIdHash = crypto
        .createHash('sha256')
        .update(`${this.appId}:${this.secretKey}`)
        .digest('hex');

      const payload = {
        grant_type: 'authorization_code',
        appIdHash: appIdHash,
        code: authCode,
      };

      // Updated to v3 endpoint
      const response = await axios.post(
        'https://api-t1.fyers.in/api/v3/validate-authcode',
        payload,
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (response.data.code === 200 && response.data.s === 'ok') {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token;

        this.expiresAt = deriveExpiryUtc(this.accessToken, null, this.logger);
        this.saveToken({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: this.expiresAt,
        });

        this._scheduleAutoRefresh();

        this.logger.info('✅ Fyers API v3 access token obtained successfully');
        return this.accessToken;
      } else {
        throw new Error(`Fyers auth failed: ${response.data.message || 'Unknown error'}`);
      }
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to get Fyers access token');
      throw error;
    }
  }


  // Refresh Access Token using Refresh Token
  async refreshAccessToken() {
    if (!this.refreshToken) {
      this.logger.error('Cannot refresh: No refresh token available');
      return false;
    }
    if (!this.pin) {
      this.logger.error('Cannot refresh: PIN not configured');
      return false;
    }

    try {
      const appIdHash = crypto
        .createHash('sha256')
        .update(`${this.appId}:${this.secretKey}`)
        .digest('hex');

      const payload = {
        grant_type: 'refresh_token',
        appIdHash: appIdHash,
        refresh_token: this.refreshToken,
        pin: this.pin
      };

      this.logger.info('Sending refresh token request...');
      const response = await axios.post(
        'https://api-t1.fyers.in/api/v3/validate-refresh-token',
        payload,
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (response.data.code === 200 && response.data.s === 'ok') {
        this.accessToken = response.data.access_token;
        // Fyers might rotate the refresh token
        if (response.data.refresh_token) {
          this.refreshToken = response.data.refresh_token;
        }

        this.expiresAt = deriveExpiryUtc(this.accessToken, null, this.logger);

        this.saveToken({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: this.expiresAt,
        });

        this._scheduleAutoRefresh();

        this.logger.info('✅ Token refreshed successfully');
        return true;
      } else {
        this.logger.error(`Token refresh failed: ${response.data.message}`);
        return false;
      }
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to refresh token');
      return false;
    }
  }

  // Save token to file
  saveToken(tokenData) {
    const dataDir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
  }

  // Load token from file
  loadToken() {
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));

        this.accessToken = tokenData.accessToken;
        this.refreshToken = tokenData.refreshToken;
        this.expiresAt = deriveExpiryUtc(this.accessToken, tokenData.expiresAt || 0, this.logger);

        // Check if token is still valid (not expired)
        if (this.expiresAt && Date.now() < this.expiresAt) {
          this.logger.info('Loaded existing Fyers access token');
          return true;
        } else {
          this.logger.warn('Fyers access token expired (will try refresh if available)');
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to load Fyers token');
    }
    return false;
  }

  // Check if we have a valid token
  isAuthenticated() {
    return !!this.accessToken && Date.now() < this.expiresAt;
  }

  // Get current access token (prepend appId for WS compatibility unless raw requested)
  getToken(options = {}) {
    const raw = options?.raw;
    if (!this.accessToken) return null;
    if (raw) return this.accessToken;
    if (this.accessToken.includes(':')) return this.accessToken;
    return `${this.appId}:${this.accessToken}`;
  }

  getExpiry() {
    return this.expiresAt;
  }

  _scheduleAutoRefresh() {
    if (!this.refreshToken || !this.expiresAt) return;
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }

    const now = Date.now();
    // Aim to refresh 1 minute before calculated expiry; never wait less than 30 seconds.
    let delay = this.expiresAt - now - 60 * 1000;
    if (delay < 30 * 1000) {
      delay = 30 * 1000;
    }

    this.logger.info(
      { delaySeconds: Math.round(delay / 1000) },
      'Scheduling FYERS token auto-refresh'
    );

    this._refreshTimer = setTimeout(async () => {
      try {
        const ok = await this.refreshAccessToken();
        if (ok) {
          this._scheduleAutoRefresh();
        } else {
          this.logger.error('Auto-refresh of FYERS token failed (refreshAccessToken returned false)');
        }
      } catch (error) {
        this.logger.error({ error }, 'Auto-refresh of FYERS token threw an error');
      }
    }, delay);
  }

  // Clear token
  clearToken() {
    this.accessToken = null;
    this.expiresAt = 0;
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
  }
}
