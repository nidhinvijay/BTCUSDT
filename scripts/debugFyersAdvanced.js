import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const TOKEN_FILE = path.resolve('data', 'fyers_token.json');
let accessToken = '';

try {
    const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    accessToken = tokenData.accessToken;
} catch (e) {
    console.error('Could not read token file:', e.message);
    process.exit(1);
}

const appId = process.env.FYERS_APP_ID;

async function testEndpoint(name, url, headers) {
    console.log(`\n--- Testing ${name} ---`);
    console.log(`URL: ${url}`);

    // Add browser-like User-Agent
    const finalHeaders = {
        ...headers,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
    };

    try {
        const response = await axios.get(url, { headers: finalHeaders });
        console.log('✅ Success:', response.status);
        console.log('Data:', JSON.stringify(response.data).substring(0, 200) + '...');
    } catch (error) {
        console.log('❌ Error:', error.response ? error.response.status : error.message);
        if (error.response && error.response.data) {
            // Try to log data, it might be HTML (Cloudflare/WAF page)
            const dataStr = typeof error.response.data === 'object'
                ? JSON.stringify(error.response.data)
                : error.response.data.toString();

            if (dataStr.includes('Cloudflare') || dataStr.includes('Security')) {
                console.log('⚠️  Seems to be blocked by WAF/Cloudflare');
            } else {
                console.log('Error Data:', dataStr.substring(0, 200));
            }
        }
    }
}

async function main() {
    console.log('Testing with Browser User-Agent...');

    // 1. Test Profile
    await testEndpoint(
        'Profile (AppID:Token)',
        'https://api.fyers.in/api/v3/profile',
        { 'Authorization': `${appId}:${accessToken}` }
    );

    // 2. Test Data API
    await testEndpoint(
        'Quotes (AppID:Token)',
        'https://api.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX',
        { 'Authorization': `${appId}:${accessToken}` }
    );
    // 3. Test User Suggestion: myapi.fyers.in
    await testEndpoint(
        'User Suggestion (myapi.fyers.in)',
        'https://myapi.fyers.in/api/v3/profile',
        { 'Authorization': `${appId}:${accessToken}` }
    );

    // 4. Test Data API on myapi
    await testEndpoint(
        'Quotes on myapi',
        'https://myapi.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX',
        { 'Authorization': `${appId}:${accessToken}` }
    );
}

main();
