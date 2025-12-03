import { test } from 'node:test';
import assert from 'node:assert';
import { createLiveController } from '../src/trading/liveController.js';
import { MockSignalBus, mockLogger } from './mocks.js';

function createIntegrationBot(symbol) {
  const fsmState = {
    buyProfitWindowStartTs: null,
    sellProfitWindowStartTs: null,
  };
  const pnl = {
    symbol,
    totalPnl: 0,
    longTotalPnl: 0,
    shortTotalPnl: 0,
    lastPrice: 100,
    longStats: { realizedPnl: 0 },
    shortStats: { realizedPnl: 0 },
  };

  return {
    pnlContext: {
      getSnapshot() {
        return pnl;
      },
      setLongTotal(v) {
        pnl.longTotalPnl = v;
      },
      setShortTotal(v) {
        pnl.shortTotalPnl = v;
      },
      setLastPrice(price) {
        pnl.lastPrice = price;
      },
    },
    fsm: {
      longPosition: null,
      shortPosition: null,
      getLongPosition() {
        return this.longPosition;
      },
      getShortPosition() {
        return this.shortPosition;
      },
      manualCloseAll() {
        return true;
      },
      forceCloseLong() {
        this.longForceClosed = true;
        return true;
      },
      forceCloseShort() {
        this.shortForceClosed = true;
        return true;
      },
      getState() {
        return {
          buyProfitWindowStartTs: fsmState.buyProfitWindowStartTs,
          sellProfitWindowStartTs: fsmState.sellProfitWindowStartTs,
        };
      },
    },
    signalBus: new MockSignalBus(),
  };
}

test('LiveController side-specific promotion with Indian-style symbol', async (t) => {
  const symbol = 'BANKNIFTY';
  const paperBot = createIntegrationBot(symbol);
  const liveBot = createIntegrationBot(symbol);

  const controller = createLiveController({
    paperBot,
    liveBot,
    logger: mockLogger,
    gateConfig: { enabled: true, threshold: 100 },
  });

  await t.test('Promotes profitable long side only', () => {
    // Paper has profitable LONG position
    paperBot.pnlContext.setLastPrice(110);
    paperBot.fsm.longPosition = { qty: 1, entryPrice: 100 };
    paperBot.pnlContext.setLongTotal(150);

    let buySignalEmitted = false;
    liveBot.signalBus.onBuy(() => {
      buySignalEmitted = true;
    });

    controller.onTick();
    assert.strictEqual(controller.isLiveActive(), true);
    assert.strictEqual(
      buySignalEmitted,
      true,
      'Profitable long should be promoted via synthetic BUY',
    );
  });

  await t.test('Short side promotes independently', () => {
    // Reset signals
    let sellSignalEmitted = false;
    liveBot.signalBus.onSell(() => {
      sellSignalEmitted = true;
    });

    // Paper has profitable SHORT position now
    paperBot.pnlContext.setLastPrice(110);
    paperBot.fsm.shortPosition = { qty: 1, entryPrice: 100 };
    paperBot.pnlContext.setShortTotal(150);

    controller.onTick();
    assert.strictEqual(
      sellSignalEmitted,
      true,
      'Profitable short should be promoted via synthetic SELL',
    );
  });
});
