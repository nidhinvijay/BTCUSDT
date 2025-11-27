// src/brokers/fyersAuth.js
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TOKEN_FILE = path.resolve('data', 'fyers_token.json');

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

    // Try to load existing token
    this.loadToken();
  }

  // Initialize: Check expiry and refresh if needed
  async initialize() {
    if (this.isAuthenticated()) {
      return true;
    }

    if (this.refreshToken) {
      this.logger.info('Access token expired, attempting refresh...');
      return await this.refreshAccessToken();
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
        
        // Calculate next 9:00 AM IST (market open time when tokens expire)
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
        const nowIST = new Date(now.getTime() + istOffset);
        const next9AM = new Date(nowIST);
        next9AM.setHours(9, 0, 0, 0);
        
        // If it's already past 9 AM today, set to 9 AM tomorrow
        if (nowIST.getHours() >= 9) {
          next9AM.setDate(next9AM.getDate() + 1);
        }
        
        const expiresAt = next9AM.getTime() - istOffset; // Convert back to UTC for storage
        
        this.saveToken({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: expiresAt,
        });

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

        // Calculate next 9:00 AM IST (market open time when tokens expire)
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
        const nowIST = new Date(now.getTime() + istOffset);
        const next9AM = new Date(nowIST);
        next9AM.setHours(9, 0, 0, 0);
        
        // If it's already past 9 AM today, set to 9 AM tomorrow
        if (nowIST.getHours() >= 9) {
          next9AM.setDate(next9AM.getDate() + 1);
        }
        
        const expiresAt = next9AM.getTime() - istOffset; // Convert back to UTC for storage

        this.saveToken({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: expiresAt,
        });

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
        this.expiresAt = tokenData.expiresAt || 0;

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

  // Get current access token
  getToken() {
    return this.accessToken;
  }

  // Clear token
  clearToken() {
    this.accessToken = null;
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
  }
}
