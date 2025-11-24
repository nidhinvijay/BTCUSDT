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

async function testBrowserLikeRequest() {
    const url = 'https://api.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX';

    console.log(`\n--- Testing Browser-Like Request ---`);
    console.log(`URL: ${url}`);

    const headers = {
        'Authorization': `${appId}:${accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://trade.fyers.in',
        'Referer': 'https://trade.fyers.in/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
    };

    console.log('Headers:', JSON.stringify(headers, null, 2));

    try {
        const response = await axios.get(url, { headers });
        console.log('✅ Success:', response.status);
        console.log('Data:', JSON.stringify(response.data).substring(0, 100));
    } catch (error) {
        console.log('❌ Error:', error.response ? error.response.status : error.message);
        if (error.response) {
            console.log('Response Data:', JSON.stringify(error.response.data));
            console.log('Response Headers:', JSON.stringify(error.response.headers));
        }
    }
}

testBrowserLikeRequest();
