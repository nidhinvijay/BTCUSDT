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
    }
}

async function main() {
    console.log('Testing Fyers API URL Permutations...');

    // 1. Standard Data API (api.fyers.in)
    await testEndpoint('Standard Data API', 'https://api.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');

    // 2. Alternative Domain (api-t1.fyers.in)
    await testEndpoint('Alternative Domain (api-t1)', 'https://api-t1.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');

    // 3. Alternative Path (api/v3 instead of data-rest/v3) - api.fyers.in
    await testEndpoint('Alternative Path (api/v3)', 'https://api.fyers.in/api/v3/quotes?symbols=NSE:NIFTY50-INDEX');

    // 4. Alternative Domain + Path (api-t1 + api/v3)
    await testEndpoint('Alt Domain + Path (api-t1 + api/v3)', 'https://api-t1.fyers.in/api/v3/quotes?symbols=NSE:NIFTY50-INDEX');

    // 5. User Suggestion: trade.fyers.in (Website Domain)
    await testEndpoint('Website Domain (trade.fyers.in/api/v3)', 'https://trade.fyers.in/api/v3/quotes?symbols=NSE:NIFTY50-INDEX');
    await testEndpoint('Website Domain (trade.fyers.in/data-rest/v3)', 'https://trade.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');
}

main();
