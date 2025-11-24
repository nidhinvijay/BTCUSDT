import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const TOKEN_FILE = path.resolve('data', 'fyers_token.json');
const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
const accessToken = tokenData.accessToken;
const appId = process.env.FYERS_APP_ID;

async function testQuote(baseUrl, authHeader, symbol = 'NSE:NIFTY50-INDEX') {
    console.log(`Testing ${baseUrl} with Symbol: ${symbol}`);
    try {
        const response = await axios.get(`${baseUrl}/quotes`, {
            headers: {
                Authorization: authHeader
            },
            params: {
                symbols: symbol
            }
        });
        console.log('Response:', response.data);
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        console.error('Status:', error.response ? error.response.status : 'N/A');
    }
}

async function main() {
    const baseUrlT1 = 'https://api-t1.fyers.in/data-rest/v3';
    const baseUrl = 'https://api.fyers.in/data-rest/v3';

    console.log('\n--- Test D: api-t1 without trailing slash, Token only ---');
    await testQuote(baseUrlT1, accessToken);

    console.log('\n--- Test E: api-t1 without trailing slash, AppID:Token ---');
    await testQuote(baseUrlT1, `${appId}:${accessToken}`);

    console.log('\n--- Test F: api.fyers.in with NSE:SBIN-EQ ---');
    await testQuote(baseUrl, `${appId}:${accessToken}`, 'NSE:SBIN-EQ');

    console.log('\n--- Test G: api.fyers.in with NSE:NIFTY50-INDEX ---');
    await testQuote(baseUrl, `${appId}:${accessToken}`, 'NSE:NIFTY50-INDEX');
}

main();
