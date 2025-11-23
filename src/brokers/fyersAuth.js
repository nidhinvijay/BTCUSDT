// src/brokers/fyersAuth.js
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TOKEN_FILE = path.resolve('data', 'fyers_token.json');

export class FyersAuth {
  constructor({ appId, secretKey, redirectUri, logger }) {
    this.appId = appId;
    this.secretKey = secretKey;
    this.redirectUri = redirectUri;
    this.logger = logger;
    this.accessToken = null;
    
    // Try to load existing token
    this.loadToken();
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
        this.saveToken({
          accessToken: this.accessToken,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
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
        
        // Check if token is still valid (not expired)
        if (tokenData.expiresAt && Date.now() < tokenData.expiresAt) {
          this.accessToken = tokenData.accessToken;
          this.logger.info('Loaded existing Fyers access token');
          return true;
        } else {
          this.logger.warn('Fyers token expired');
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to load Fyers token');
    }
    return false;
  }

  // Check if we have a valid token
  isAuthenticated() {
    return !!this.accessToken;
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
