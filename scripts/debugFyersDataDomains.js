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
    console.log('Testing Fyers Data Domains...');

    // 1. api-t1 (Re-test with data-rest)
    await testEndpoint('api-t1 (data-rest)', 'https://api-t1.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');

    // 2. data-t1 (Hypothetical)
    await testEndpoint('data-t1 (data-rest)', 'https://data-t1.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');

    // 3. dl-t1 (Hypothetical)
    await testEndpoint('dl-t1 (data-rest)', 'https://dl-t1.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');

    // 4. api (Re-test)
    await testEndpoint('api (data-rest)', 'https://api.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');

    // 5. data.fyers.in (Final check)
    await testEndpoint('data.fyers.in (data-rest)', 'https://data.fyers.in/data-rest/v3/quotes?symbols=NSE:NIFTY50-INDEX');
}

main();
