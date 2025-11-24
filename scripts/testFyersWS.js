import WebSocket from 'ws';
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

function testWebSocket(url) {
    console.log(`\n--- Testing WebSocket: ${url} ---`);
    const ws = new WebSocket(`${url}?access_token=${appId}:${accessToken}`);

    ws.on('open', () => {
        console.log(`✅ Connected to ${url}`);
        // Send a subscription message if needed, but connection is enough proof
        ws.close();
    });

    ws.on('error', (err) => {
        console.log(`❌ Error connecting to ${url}:`, err.message);
    });

    ws.on('close', (code, reason) => {
        console.log(`Disconnected from ${url} (Code: ${code})`);
    });
}

async function main() {
    // 1. Standard WS URL
    testWebSocket('wss://api.fyers.in/socket/v3/data');

    // 2. Alternative WS URL (api-t1)
    testWebSocket('wss://api-t1.fyers.in/socket/v3/data');

    // 3. Data Socket URL (data-socket)
    testWebSocket('wss://data-socket.fyers.in/socket/v3/data');
}

main();
