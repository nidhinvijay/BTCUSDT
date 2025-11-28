
import { test } from 'node:test';
import assert from 'node:assert';
import { createFSM } from '../src/trading/fsm.js';
import { createPnlContext } from '../src/trading/pnlContext.js';
import { MockSignalBus, MockBroker, mockLogger } from './mocks.js';

test('FSM Short Strategy Scenarios', async (t) => {

  await t.test('Scenario 1: Happy Path Short (Signal -> Entry -> Profit)', () => {
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

    assert.strictEqual(fsm.getSellState(), 'WAIT_FOR_SIGNAL');

    // Trigger Sell Signal
    signalBus.triggerSell();
    assert.strictEqual(fsm.getSellState(), 'SELLSIGNAL');

    // First Tick
    // ltp = 100. Entry Trigger = 99.5, Stop = 100.5
    fsm.onTick({ ltp: 100, ts: 1000 });
    assert.strictEqual(fsm.getSellState(), 'SELLENTRY_WINDOW');
    const anchors = fsm.getAnchors();
    assert.strictEqual(anchors.sellEntryTrigger, 99.5);
    assert.strictEqual(anchors.sellStop, 100.5);

    // Hit Entry Trigger (99.5)
    fsm.onTick({ ltp: 99.5, ts: 2000 });
    assert.strictEqual(fsm.getSellState(), 'SELLPROFIT_WINDOW');

    const orders = broker.getOrders();
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].type, 'SELL'); // Open Short
    assert.strictEqual(orders[0].price, 99.5);

    const pos = fsm.getShortPosition();
    assert.strictEqual(pos.side, 'SHORT');
    assert.strictEqual(pos.entryPrice, 99.5);

    // Manual Close
    fsm.manualCloseAll();
    assert.strictEqual(fsm.getSellState(), 'WAIT_FOR_SIGNAL');
    assert.strictEqual(fsm.getShortPosition(), null);
  });

  await t.test('Scenario 2: Stop Loss Short', () => {
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

    signalBus.triggerSell();
    fsm.onTick({ ltp: 100, ts: 1000 }); // Trigger: 99.5, Stop: 100.5
    fsm.onTick({ ltp: 99.5, ts: 2000 }); // Enter Short
    
    assert.strictEqual(fsm.getSellState(), 'SELLPROFIT_WINDOW');

    // Hit Stop Loss (100.5)
    fsm.onTick({ ltp: 100.5, ts: 3000 });
    
    assert.strictEqual(fsm.getShortPosition(), null);
    assert.strictEqual(fsm.getSellState(), 'WAIT_WINDOW');

    const orders = broker.getOrders();
    assert.strictEqual(orders.length, 2); // Sell Entry + Buy Close
    assert.strictEqual(orders[1].type, 'BUY');
    assert.strictEqual(orders[1].price, 100.5);
  });

});
