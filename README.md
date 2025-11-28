# Multi-Asset Paper Trading Bot (Dual FSM)(HydraTrader)

A robust paper trading engine designed for both Crypto (Binance) and Indian Indices (Fyers). It features a **Dual Finite State Machine (FSM)** architecture, allowing independent management of Long (BUY) and Short (SELL) strategies simultaneously.

## Features

- **Dual FSM Architecture**: Independent state machines for Long and Short positions, enabling simultaneous hedging or bi-directional trading.
- **Multi-Asset Support**:
  - **Crypto**: Real-time data from Binance (e.g., BTCUSDT).
  - **Indian Indices**: Real-time data from Fyers (e.g., NIFTY, BANKNIFTY, SENSEX).
- **Real-Time Dashboard**:
  - Web-based UI to monitor FSM states, PnL, and active positions.
  - Manual controls for closing positions or resetting the system.
  - Fyers OAuth v3 integration directly from the dashboard.
- **Signal Integration**: Accepts `BUY`/`SELL` signals via TradingView webhooks.
- **Robust State Management**:
  - Auto-resumes state after restarts.
  - Persists session data and PnL metrics.
- **Configurable**: Easy setup for symbols, lot sizes, and strategy parameters via `.env` and config files.

## Prerequisites

- Node.js (v16 or higher)
- A Fyers account (for Indian indices)
- TradingView account (for sending signals)

## Installation

1. **Clone the repository**
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Configure Environment**:
   Create a `.env` file in the root directory:
   ```env
   PORT=3000
   LOG_LEVEL=info
   
   # Fyers Configuration (Optional, for Indian Indices)
   FYERS_APP_ID=your_app_id
   FYERS_SECRET_KEY=your_secret_key
   FYERS_REDIRECT_URI=http://localhost:3000/fyers/callback
   FYERS_WS_LOG_PATH=./fyers-logs    # optional websocket log directory

   # Live gate (paper -> live handoff)
   LIVE_GATE_ENABLED=true            # set to false to keep LIVE stack always active
   LIVE_GATE_THRESHOLD=0             # min cumulative paper PnL required to activate LIVE
   ```

## Usage

### Starting the Bot
```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

### Fyers Authentication
For Indian indices, you need to authenticate with Fyers:
1. Start the bot.
2. Open the dashboard at `http://localhost:3000`.
3. Click the **"Authorize Fyers"** button if prompted.
4. Complete the login flow. The token will be saved automatically.

### Dashboard
Access the dashboard at `http://localhost:3000`.
- **Symbol Tabs**: Switch between active symbols (BTCUSDT, NIFTY, etc.).
- **Strategy Tabs**: View independent states for LONG and SHORT strategies.
- **Performance**: Track Realized/Unrealized PnL, Win Rate, and Trade History.

### Live Gate (Paper → Live Relay)
The live FSM only receives signals when the cumulative paper PnL is above a threshold (default `0`).  
Use the new environment variables to adjust this behavior:
- `LIVE_GATE_ENABLED=false` keeps the live stack active at all times (helpful for local testing).
- `LIVE_GATE_THRESHOLD=-25` (example) requires paper to stay above -25 before forwarding signals.
When the gate disables the live stack it also flattens any open live positions automatically.

## Deployment (VM)

A setup script is provided for Ubuntu/Debian VMs (e.g., GCP, AWS, DigitalOcean).

1. **Transfer files** to your VM.
2. **Run the setup script** (installs Node.js 20, PM2, and configures firewall):
   ```bash
   chmod +x deploy_vm.sh
   ./deploy_vm.sh
   ```
3. **Start the application**:
   ```bash
   npm install
   pm2 start src/index.js --name trader
   pm2 save
   pm2 startup
   ```
4. **Monitor**:
   ```bash
   pm2 logs
   pm2 monit
   ```

## Architecture

- **`src/trading/fsm.js`**: Core Dual FSM logic.
- **`src/exchange/`**: Market data adapters (Binance WebSocket, Fyers WebSocket).
- **`src/signals/tradingviewServer.js`**: Express server handling webhooks and serving the dashboard.
- **`src/brokers/fyersAuth.js`**: Fyers OAuth v3 implementation.

### FYERS Live Data (WS)

- We now mirror the working `part3Final` setup by streaming Indian indices directly from FYERS' official websocket SDK (`fyers-api-v3`).
- Install the dependency after pulling changes: `npm install fyers-api-v3`.
- `npm run auth` still stores the raw access token; the websocket client automatically builds the `${FYERS_APP_ID}:${access_token}` string.
- Optional logs from the SDK are written to `FYERS_WS_LOG_PATH` (defaults to `data/fyers-logs`).

## Webhook Format

Send alerts from TradingView to `http://your-server-ip:3000/webhook` with the message body:
```text
sym=BTCUSDT side=BUY
```
or
```text
sym=NIFTY side=SELL
```

---
*Note: This is a paper trading bot. No real money is used.*
