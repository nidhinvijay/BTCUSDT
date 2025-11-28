# Test Harness Documentation

This directory contains the automated test suite for the BTCUSDT-Binance trading bot. The tests use the built-in `node:test` runner (Node.js v20+).

## How to Run Tests

### Run All Tests
To execute the entire test suite:
```bash
npm test
```

### Run Individual Tests
To run a specific test file (useful for debugging):
```bash
node --test tests/test_fsm_long.js
node --test tests/test_fsm_short.js
node --test tests/test_pnl.js
node --test tests/test_live_switch.js
node --test tests/test_resumption.js
```

## What is Tested?

The test harness covers the critical logic of the trading system without connecting to live exchanges. It uses "mocks" to simulate market data and broker interactions.

### 1. Long Strategy (`tests/test_fsm_long.js`)
- **Happy Path**: Verifies that a BUY signal triggers an entry when price hits the trigger, and closes for profit when target is reached.
- **Stop Loss**: Verifies that the position is closed immediately if the price hits the stop loss level.
- **Entry Expiry**: Verifies that if the entry trigger is not hit within 60 seconds, the window expires and the bot waits for the next opportunity.

### 2. Short Strategy (`tests/test_fsm_short.js`)
- **Happy Path**: Verifies SELL signal -> Entry -> Profit.
- **Stop Loss**: Verifies stop loss logic for short positions.

### 3. PnL & Metrics (`tests/test_pnl.js`)
- **Calculations**: Ensures Realized and Unrealized PnL are calculated correctly for both Long and Short trades.
- **Metrics**: Verifies that Win Rate, Profit Factor, and Trade Counts are updated correctly.

### 4. Live Switch (`tests/test_live_switch.js`)
- **Activation/Deactivation**: Verifies the gate logic based on Paper PnL threshold.
- **Signal Forwarding**: Ensures signals only reach the Live bot when the gate is open.
- **Position Promotion**: Verifies that profitable Paper positions are "promoted" to Live (via synthetic signals) when the gate opens.
- **Corner Case**: Tests the scenario where Live deactivates (Paper PnL goes negative), a SELL signal arrives (only Paper takes it), then Paper becomes profitable again and Live reactivates with position promotion.

### 5. State Resumption (`tests/test_resumption.js`)
- **Crash Recovery**: Verifies that if the bot restarts, it can correctly reload its state (e.g., remembering it has an active position) from the saved database.

## Project Integrity
**Note:** These tests do NOT modify your main project logic. They import your existing code (`src/trading/fsm.js`, etc.) and run it in a controlled environment.
