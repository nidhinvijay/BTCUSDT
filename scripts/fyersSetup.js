// scripts/fyersSetup.js
// Run this script to authenticate with Fyers and get your access token

import dotenv from 'dotenv';
import { FyersAuth } from '../src/brokers/fyersAuth.js';
import { logger } from '../src/utils/logger.js';
import readline from 'readline';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('\n=== Fyers Authentication Setup ===\n');

  const appId = process.env.FYERS_APP_ID;
  const secretKey = process.env.FYERS_SECRET_KEY;

  const redirectUri = process.env.FYERS_REDIRECT_URI;
  const pin = process.env.FYERS_PIN;

  if (!appId || !secretKey || appId === 'YOUR_FYERS_APP_ID') {
    console.error('❌ Please set FYERS_APP_ID and FYERS_SECRET_KEY in your .env file first!');
    console.log('\nGet your credentials from: https://myapi.fyers.in/dashboard');
    process.exit(1);
  }

  const fyersAuth = new FyersAuth({
    appId,
    secretKey,
    redirectUri,
    pin,
    logger
  });

  // Check if already authenticated
  if (fyersAuth.isAuthenticated()) {
    console.log('✅ You are already authenticated!');
    console.log(`Access Token: ${fyersAuth.getToken()}`);
    rl.close();
    return;
  }

  // Step 1: Generate auth URL
  const { authUrl, state } = fyersAuth.getAuthCodeUrl();

  console.log('\n📋 Step 1: Open this URL in your browser and login:\n');
  console.log(authUrl);
  console.log('\n');

  // Step 2: Get auth code from user
  console.log('After logging in, you will see the AUTH CODE (JWT token).');
  console.log('It looks like: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...\n');

  const input = await question('Paste the AUTH CODE (JWT token) here: ');

  // Try to extract auth code - v3 returns JWT directly
  let authCode = input.trim();

  // If user pasted a URL instead of token, try to extract
  if (authCode.startsWith('http')) {
    try {
      const urlObj = new URL(authCode);
      const codeFromUrl = urlObj.searchParams.get('auth_code');
      const returnedState = urlObj.searchParams.get('state');

      if (codeFromUrl) {
        authCode = codeFromUrl;
        if (returnedState !== state) {
          console.error('❌ State mismatch! Possible security issue. Please try again.');
          rl.close();
          process.exit(1);
        }
      }
    } catch (err) {
      // Not a valid URL, assume it's the JWT token directly
    }
  }

  if (!authCode || authCode.length < 20) {
    console.error('❌ Invalid auth code. Please try again.');
    rl.close();
    process.exit(1);
  }

  console.log('\n⏳ Getting access token...\n');

  // Step 3: Exchange auth code for access token
  try {
    const accessToken = await fyersAuth.getAccessToken(authCode);
    console.log('✅ Success! Access token obtained and saved.\n');
    console.log(`Access Token: ${accessToken}\n`);
    console.log('You can now start your trading bot with: npm start');
  } catch (error) {
    console.error('❌ Failed to get access token:', error.message);
    process.exit(1);
  }

  rl.close();
}

main().catch(console.error);
