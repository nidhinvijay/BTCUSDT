
import { test } from 'node:test';
import assert from 'node:assert';
import { createFSM } from '../src/trading/fsm.js';
import { createPnlContext } from '../src/trading/pnlContext.js';
import { MockSignalBus, MockBroker, mockLogger } from './mocks.js';

test('FSM Long Strategy Scenarios', async (t) => {
  
  await t.test('Scenario 1: Happy Path Long (Signal -> Entry -> Profit)', () => {
    const signalBus = new MockSignalBus();
    const broker = new MockBroker();
    const pnlContext = createPnlContext({ symbol: 'BTCUSDT' });
    const fsm = createFSM({
      symbol: 'BTCUSDT',
      signalBus,
      broker,
      pnlContext,
      logger: mockLogger
    });

    // 1. Initial State
    assert.strictEqual(fsm.getBuyState(), 'WAIT_FOR_SIGNAL');

    // 2. Trigger Buy Signal
    signalBus.triggerBuy();
    assert.strictEqual(fsm.getBuyState(), 'BUYSIGNAL');

    // 3. First Tick (sets anchors)
    // ltp = 100. Entry Trigger = 100.5, Stop = 99.5
    fsm.onTick({ ltp: 100, ts: 1000 });
    assert.strictEqual(fsm.getBuyState(), 'BUYENTRY_WINDOW');
    const anchors = fsm.getAnchors();
    assert.strictEqual(anchors.buyEntryTrigger, 100.5);
    assert.strictEqual(anchors.buyStop, 99.5);

    // 4. Tick hits Entry Trigger (100.5)
    fsm.onTick({ ltp: 100.5, ts: 2000 });
    assert.strictEqual(fsm.getBuyState(), 'BUYPROFIT_WINDOW');
    
    // Verify Order
    const orders = broker.getOrders();
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].type, 'BUY');
    assert.strictEqual(orders[0].price, 100.5);

    // Verify Position
    const pos = fsm.getLongPosition();
    assert.strictEqual(pos.side, 'LONG');
    assert.strictEqual(pos.entryPrice, 100.5);

    // 5. Manual Close (Simulating Profit Take or Manual Exit)
    // For this test, let's simulate a manual close to verify clean exit
    fsm.manualCloseAll();
    assert.strictEqual(fsm.getBuyState(), 'WAIT_FOR_SIGNAL');
    assert.strictEqual(fsm.getLongPosition(), null);
    
    // Verify Close Order
    const ordersAfterClose = broker.getOrders();
    assert.strictEqual(ordersAfterClose.length, 2);
    assert.strictEqual(ordersAfterClose[1].type, 'SELL');
  });

  await t.test('Scenario 2: Stop Loss Long', () => {
    const signalBus = new MockSignalBus();
    const broker = new MockBroker();
    const pnlContext = createPnlContext({ symbol: 'BTCUSDT' });
    const fsm = createFSM({
      symbol: 'BTCUSDT',
      signalBus,
      broker,
      pnlContext,
      logger: mockLogger
    });

    // Signal -> Entry
    signalBus.triggerBuy();
    fsm.onTick({ ltp: 100, ts: 1000 }); // Trigger: 100.5, Stop: 99.5
    fsm.onTick({ ltp: 100.5, ts: 2000 }); // Enter Long
    
    assert.strictEqual(fsm.getBuyState(), 'BUYPROFIT_WINDOW');

    // Hit Stop Loss (99.5)
    fsm.onTick({ ltp: 99.5, ts: 3000 });
    
    // Should close position and go to WAIT_WINDOW
    assert.strictEqual(fsm.getLongPosition(), null);
    // Note: Implementation goes to WAIT_WINDOW then WAIT_FOR_BUYENTRY
    // We can check if we are in WAIT_WINDOW
    assert.strictEqual(fsm.getBuyState(), 'WAIT_WINDOW');

    const orders = broker.getOrders();
    assert.strictEqual(orders.length, 2); // Buy Entry + Sell Close
    assert.strictEqual(orders[1].type, 'SELL');
    assert.strictEqual(orders[1].price, 99.5);
  });

  await t.test('Scenario 3: Entry Expiry (No Entry Trigger)', () => {
    const signalBus = new MockSignalBus();
    const broker = new MockBroker();
    const pnlContext = createPnlContext({ symbol: 'BTCUSDT' });
    const fsm = createFSM({
      symbol: 'BTCUSDT',
      signalBus,
      broker,
      pnlContext,
      logger: mockLogger
    });

    signalBus.triggerBuy();
    fsm.onTick({ ltp: 100, ts: 1000 }); // Window starts at 1000
    assert.strictEqual(fsm.getBuyState(), 'BUYENTRY_WINDOW');

    // Tick within window but no trigger -> Enters WAIT_WINDOW
    fsm.onTick({ ltp: 100.2, ts: 30000 });
    assert.strictEqual(fsm.getBuyState(), 'WAIT_WINDOW');

    // Tick after window expiry (60s = 60000ms)
    // 1000 + 60001 = 61001. Using 70000 to be safe.
    fsm.onTick({ ltp: 100.2, ts: 70000 });
    
    // Should transition to BUYENTRY_WINDOW (exited WAIT_WINDOW)
    assert.strictEqual(fsm.getBuyState(), 'BUYENTRY_WINDOW');

    // Next tick should realize the window is expired and move to WAIT_FOR_BUYENTRY
    fsm.onTick({ ltp: 100.2, ts: 71000 });
    assert.strictEqual(fsm.getBuyState(), 'WAIT_FOR_BUYENTRY');
    
    // Send a new tick to restart the window (WAIT_FOR_BUYENTRY also has a 60s window)
    // But let's just verify we are in the correct state.
  });


});
