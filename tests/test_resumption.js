
import { test } from 'node:test';
import assert from 'node:assert';
import { createFSM } from '../src/trading/fsm.js';
import { createPnlContext } from '../src/trading/pnlContext.js';
import { MockSignalBus, MockBroker, mockLogger } from './mocks.js';

test('FSM Resumption Logic', async (t) => {
  
  await t.test('Restore Active Long Position', () => {
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

    // Create a state object representing an active LONG in BUYPROFIT_WINDOW
    const savedState = {
      buyState: 'BUYPROFIT_WINDOW',
      sellState: 'WAIT_FOR_SIGNAL',
      longPosition: { side: 'LONG', qty: 1, entryPrice: 50000, stop: 49000 },
      buyProfitWindowStartTs: 100000,
      buyStop: 49000
    };

    fsm.restoreState(savedState);

    assert.strictEqual(fsm.getBuyState(), 'BUYPROFIT_WINDOW');
    const pos = fsm.getLongPosition();
    assert.strictEqual(pos.side, 'LONG');
    assert.strictEqual(pos.entryPrice, 50000);
    
    // Resume ticking
    // Tick below stop -> Should close
    fsm.onTick({ ltp: 48000, ts: 101000 });
    
    assert.strictEqual(fsm.getLongPosition(), null);
    // Should have placed a SELL order
    const orders = broker.getOrders();
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].type, 'SELL');
  });

});
