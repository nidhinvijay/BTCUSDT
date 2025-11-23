#!/bin/bash

echo "🔄 Updating Configuration..."

# Prompt for new values
read -p "Enter Binance API Key (press Enter to keep current): " BINANCE_KEY
read -p "Enter Binance Secret (press Enter to keep current): " BINANCE_SECRET
read -p "Enter Fyers App ID (press Enter to keep current): " FYERS_ID
read -p "Enter Fyers Secret (press Enter to keep current): " FYERS_SECRET

# Load existing values if available
if [ -f .env ]; then
    source .env
fi

# Use existing values if input is empty
BINANCE_KEY=${BINANCE_KEY:-$BINANCE_API_KEY}
BINANCE_SECRET=${BINANCE_SECRET:-$BINANCE_API_SECRET}
FYERS_ID=${FYERS_ID:-$FYERS_APP_ID}
FYERS_SECRET=${FYERS_SECRET:-$FYERS_SECRET_KEY}

# Write new .env
cat <<EOF > .env
BINANCE_API_KEY=$BINANCE_KEY
BINANCE_API_SECRET=$BINANCE_SECRET
PORT=3000
SYMBOL=BTCUSDT
FYERS_APP_ID=$FYERS_ID
FYERS_SECRET_KEY=$FYERS_SECRET
# REDIRECT_URI is auto-generated
EOF

echo "✅ Configuration updated!"
echo "🔄 Restarting bot to apply changes..."
pm2 restart trading-bot
echo "✅ Bot restarted!"
