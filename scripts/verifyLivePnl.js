
import { createSmartBroker } from '../src/trading/smartBroker.js';
import { createPaperBroker } from '../src/trading/paperBroker.js';
import { createLiveBroker } from '../src/trading/liveBroker.js';
import { createPnlContext } from '../src/trading/pnlContext.js';

const logger = {
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.log('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
};

async function verifyLivePnl() {
    console.log('--- Starting Verification: Live P&L Tracking ---');

    const symbol = 'BTCUSDT';
    const pnlContext = createPnlContext({ symbol });
    const paperBroker = createPaperBroker({ symbol, pnlContext, logger });
    const liveBroker = createLiveBroker({ symbol, logger });
    const smartBroker = createSmartBroker({ paperBroker, liveBroker, pnlContext, logger });

    // 1. Simulate Positive P&L to activate Live Mode
    console.log('1. Executing a winning PAPER trade to activate Live Mode...');

    // Open Long at 100
    // NOTE: Reason must contain "OPEN" or "TRIGGER_HIT" to be treated as opening a position by paperBroker
    smartBroker.placeLimitBuy(1, 100, { reason: 'SETUP_OPEN_LONG' });

    // Update price to 110 (Unrealized P&L = +10)
    pnlContext.updateMarkPrice(110);
    smartBroker.onTick(); // Trigger checkAutoSwitch -> Should activate Live Mode

    // Check if Live Mode is active
    if (smartBroker.isLive()) {
        console.log('✅ SmartBroker is now in LIVE mode.');
    } else {
        console.error('❌ SmartBroker failed to switch to LIVE mode.');
        process.exit(1);
    }

    // 2. Execute a trade in Live Mode
    console.log('2. Executing a trade in LIVE mode...');

    // Let's close the current position first to realize the profit and keep P&L > 0
    smartBroker.placeLimitSell(1, 110, { reason: 'SETUP_CLOSE_LONG' });

    // Now Total P&L is +10 (Realized). SmartBroker should still be Live.
    smartBroker.onTick();
    if (!smartBroker.isLive()) {
        console.error('❌ SmartBroker dropped out of LIVE mode unexpectedly.');
        process.exit(1);
    }

    // Open a new Long in Live Mode
    smartBroker.placeLimitBuy(1, 200, { reason: 'LIVE_TEST_OPEN_LONG' });

    // 3. Verify pnlContext has recorded it as Live
    const snapshot = pnlContext.getSnapshot();
    console.log('Snapshot Live Stats:', snapshot.liveStats);

    if (snapshot.liveStats.tradeCount >= 1) {
        console.log('✅ Live Trade Count incremented correctly.');
    } else {
        console.error('❌ Live Trade Count NOT incremented.');
        process.exit(1);
    }

    // Close it to check Realized P&L
    smartBroker.placeLimitSell(1, 210, { reason: 'LIVE_TEST_CLOSE_LONG' });

    const finalSnapshot = pnlContext.getSnapshot();
    console.log('Final Snapshot Live Stats:', finalSnapshot.liveStats);

    if (finalSnapshot.liveStats.realizedPnl > 0) {
        console.log('✅ Live Realized P&L updated correctly.');
    } else {
        console.error('❌ Live Realized P&L NOT updated.');
        process.exit(1);
    }

    console.log('--- Verification SUCCESS ---');
}

verifyLivePnl().catch(err => console.error(err));
