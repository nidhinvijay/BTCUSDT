# BTCUSDT Paper Trading Bot

Node.js bot that:

- Connects to Binance BTCUSDT trade WebSocket
- Receives BUY/SELL signals from TradingView webhooks
- Runs a finite state machine (FSM) to paper trade based on ticks and signals
- Implements custom BUY/SELL logic with 60s windows and paper PnL tracking
