
import { test } from 'node:test';
import assert from 'node:assert';
import { createLiveController } from '../src/trading/liveController.js';
import { MockSignalBus, mockLogger } from './mocks.js';

// Helper to create a mock bot stack
function createMockBot() {
  return {
    pnlContext: {
      snapshotData: { totalPnl: 0, lastPrice: 100, longStats: { realizedPnl: 0 }, shortStats: { realizedPnl: 0 } },
      getSnapshot() { return this.snapshotData; },
      setTotalPnl(pnl) { this.snapshotData.totalPnl = pnl; },
      setLastPrice(price) { this.snapshotData.lastPrice = price; }
    },
    fsm: {
      longPosition: null,
      shortPosition: null,
      getLongPosition() { return this.longPosition; },
      getShortPosition() { return this.shortPosition; },
      manualCloseAll() {}
    },
    signalBus: new MockSignalBus(),
    broker: {
      closeAll: async () => {}
    }
  };
}

test('LiveController Logic', async (t) => {

  await t.test('Scenario 1: Activation (Paper PnL > Threshold)', () => {
    const paperBot = createMockBot();
    const liveBot = createMockBot();
    
    // Config: Enable gate, Threshold = 100
    const controller = createLiveController({
      paperBot,
      liveBot,
      logger: mockLogger,
      gateConfig: { enabled: true, threshold: 100 }
    });

    // Initial state: PnL 0 <= 100 -> Live Inactive
    assert.strictEqual(controller.isLiveActive(), false);

    // Update PnL to 150 (Crosses Threshold)
    paperBot.pnlContext.setTotalPnl(150);
    controller.onTick();

    assert.strictEqual(controller.isLiveActive(), true);
  });

  await t.test('Scenario 2: Deactivation (Paper PnL <= Threshold)', () => {
    const paperBot = createMockBot();
    const liveBot = createMockBot();
    
    const controller = createLiveController({
      paperBot,
      liveBot,
      logger: mockLogger,
      gateConfig: { enabled: true, threshold: 100 }
    });

    // Start above threshold
    paperBot.pnlContext.setTotalPnl(150);
    controller.onTick();
    assert.strictEqual(controller.isLiveActive(), true);

    // Drop below threshold
    paperBot.pnlContext.setTotalPnl(90);
    controller.onTick();
    assert.strictEqual(controller.isLiveActive(), false);
  });

  await t.test('Scenario 3: Signal Forwarding', () => {
    const paperBot = createMockBot();
    const liveBot = createMockBot();
    
    const controller = createLiveController({
      paperBot,
      liveBot,
      logger: mockLogger,
      gateConfig: { enabled: true, threshold: 100 }
    });

    // 1. Inactive: Should NOT forward
    let buySignalEmitted = false;
    liveBot.signalBus.onBuy(() => { buySignalEmitted = true; });
    
    controller.forwardSignal('BUY');
    assert.strictEqual(buySignalEmitted, false);

    // 2. Activate
    paperBot.pnlContext.setTotalPnl(150);
    controller.onTick();
    assert.strictEqual(controller.isLiveActive(), true);

    // 3. Active: Should forward
    controller.forwardSignal('BUY');
    assert.strictEqual(buySignalEmitted, true);
  });

  await t.test('Scenario 4: Position Promotion', () => {
    const paperBot = createMockBot();
    const liveBot = createMockBot();
    
    const controller = createLiveController({
      paperBot,
      liveBot,
      logger: mockLogger,
      gateConfig: { enabled: true, threshold: 100 }
    });

    // Setup: Paper has profitable LONG position
    // Entry: 100, Current: 110, Qty: 1 -> Unrealized PnL +10
    paperBot.pnlContext.setLastPrice(110);
    paperBot.fsm.longPosition = { qty: 1, entryPrice: 100 };
    
    // Monitor for synthetic signal
    let buySignalEmitted = false;
    liveBot.signalBus.onBuy(() => { buySignalEmitted = true; });

    // Activate (PnL > 100)
    paperBot.pnlContext.setTotalPnl(150);
    controller.onTick();

    // Should have promoted the position via synthetic BUY signal
    assert.strictEqual(controller.isLiveActive(), true);
    assert.strictEqual(buySignalEmitted, true);
  });

});
