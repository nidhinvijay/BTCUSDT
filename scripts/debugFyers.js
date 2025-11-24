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
    console.log(`Headers:`, JSON.stringify(headers, null, 2));

    try {
        const response = await axios.get(url, { headers });
        console.log('✅ Success:', response.status);
        console.log('Data:', JSON.stringify(response.data).substring(0, 200) + '...');
    } catch (error) {
        console.log('❌ Error:', error.response ? error.response.status : error.message);
        if (error.response && error.response.data) {
            console.log('Error Data:', JSON.stringify(error.response.data));
        }
    }
}

async function main() {
    // 1. Test Profile (API v3) - Usually requires 'Authorization: appId:accessToken' or just 'Authorization: accessToken' depending on endpoint
    // Profile endpoint: https://api.fyers.in/api/v3/profile
    await testEndpoint(
        'Profile (AppID:Token)',
        'https://api.fyers.in/api/v3/profile',
        { 'Authorization': `${appId}:${accessToken}` }
    );

    // 2. Test Data API - Quotes (AppID:Token)
    // URL: https://api.fyers.in/data-rest/v3/quotes
    await testEndpoint(
        'Quotes (AppID:Token)',
        'https://api.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX',
        { 'Authorization': `${appId}:${accessToken}` }
    );

    // 3. Test Data API - Quotes (Bearer Token) - Just in case
    await testEndpoint(
        'Quotes (Bearer)',
        'https://api.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX',
        { 'Authorization': `Bearer ${accessToken}` }
    );

    // 4. Test Data API - Quotes (Token Only)
    await testEndpoint(
        'Quotes (Token Only)',
        'https://api.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX',
        { 'Authorization': accessToken }
    );
}

main();
