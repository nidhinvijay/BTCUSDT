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

async function testEndpoint(name, url) {
    console.log(`\n--- Testing ${name} ---`);
    console.log(`URL: ${url}`);

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `${appId}:${accessToken}`
            }
        });
        console.log('✅ Success:', response.status);
        console.log('Data:', JSON.stringify(response.data).substring(0, 100));
    } catch (error) {
        console.log('❌ Error:', error.response ? error.response.status : error.message);
        if (error.response && error.response.status !== 404 && error.response.status !== 503) {
            console.log('Response:', JSON.stringify(error.response.data));
        }
    }
}

async function main() {
    console.log('Testing api-t1.fyers.in Exhaustively...');

    // 1. Profile API (usually at /api/v3)
    await testEndpoint('Profile (api/v3)', 'https://api-t1.fyers.in/api/v3/profile');
    await testEndpoint('Profile (fyers-api/v3)', 'https://api-t1.fyers.in/fyers-api/v3/profile');

    // 2. Data API - Quotes
    await testEndpoint('Quotes (data-rest/v3)', 'https://api-t1.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');
    await testEndpoint('Quotes (api/v3)', 'https://api-t1.fyers.in/api/v3/quotes?symbols=NSE:NIFTY50-INDEX');
    await testEndpoint('Quotes (data/v3)', 'https://api-t1.fyers.in/data/v3/quotes?symbols=NSE:NIFTY50-INDEX');
    await testEndpoint('Quotes (v3)', 'https://api-t1.fyers.in/v3/quotes?symbols=NSE:NIFTY50-INDEX');
}

main();
