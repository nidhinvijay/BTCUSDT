import { test } from 'node:test';
import assert from 'node:assert';
import { createFSM } from '../src/trading/fsm.js';
import { createSignalBus } from '../src/signals/signalBus.js';
import { MockBroker, mockLogger } from './mocks.js';

test('Indian options: base index feed is ignored and PE/CE use separate anchors', async (t) => {
  const symbol = 'BANKNIFTY';
  const signalBus = createSignalBus();
  const broker = new MockBroker();

  const fsm = createFSM({
    symbol,
    signalBus,
    broker,
    pnlContext: {}, // not used by FSM
    logger: mockLogger,
  });

  await t.test('PE SELL signal waits for option tick (not index)', () => {
    // Simulate a PE entry routed into SELL FSM
    signalBus.emitSell({
      source: 'TradingView',
      action: 'BUY',
      optionType: 'PUT',
    });

    // First, push an index/base tick – should be ignored
    fsm.onTick({ ltp: 40000, ts: 1_000, source: 'base' });
    const anchorsAfterBase = fsm.getAnchors();
    assert.strictEqual(
      anchorsAfterBase.savedSELLLTP,
      null,
      'SELL side should ignore base index tick for Indian indices',
    );

    // Now push a PE option tick on the SELL feed
    fsm.onTick({ ltp: 120, ts: 2_000, source: 'sell' });
    const anchorsAfterOption = fsm.getAnchors();

    assert.strictEqual(
      anchorsAfterOption.savedSELLLTP,
      120,
      'SELL side anchor should come from PE option feed',
    );
    assert.ok(
      typeof anchorsAfterOption.sellEntryTrigger === 'number',
      'SELL entry trigger should be derived from option LTP',
    );
  });

  await t.test('PE trade opens via BUY order with PE leg meta', () => {
    // Fresh SELL signal and option tick to set anchors
    signalBus.emitSell({
      source: 'TradingView',
      action: 'BUY',
      optionType: 'PUT',
    });
    fsm.onTick({ ltp: 100, ts: 3_000, source: 'sell' });
    const { sellEntryTrigger } = fsm.getAnchors();

    // Next SELL tick crosses entry trigger and should open PE long
    fsm.onTick({ ltp: sellEntryTrigger - 1, ts: 3_500, source: 'sell' });

    const orders = broker.getOrders();
    assert.ok(orders.length > 0, 'Broker should have received an order');

    const lastOrder = orders[orders.length - 1];
    assert.strictEqual(
      lastOrder.type,
      'BUY',
      'Indian PUT positions should be opened with BUY orders (PE long)',
    );
    assert.strictEqual(
      lastOrder.meta.leg,
      'PE',
      'Order meta should mark leg as PE for Indian indices',
    );
  });

  await t.test('CE feed does not corrupt SELL anchors', () => {
    // Start with a fresh PE SELL signal and option tick
    signalBus.emitSell({
      source: 'TradingView',
      action: 'BUY',
      optionType: 'PUT',
    });
    fsm.onTick({ ltp: 150, ts: 4_000, source: 'sell' });
    const anchorsBeforeCE = fsm.getAnchors();

    // Now emit a CE signal and tick on BUY feed
    signalBus.emitBuy({
      source: 'TradingView',
      action: 'BUY',
      optionType: 'CALL',
    });
    fsm.onTick({ ltp: 200, ts: 4_500, source: 'buy' });

    const anchorsAfterCE = fsm.getAnchors();
    assert.strictEqual(
      anchorsAfterCE.savedSELLLTP,
      anchorsBeforeCE.savedSELLLTP,
      'SELL anchors should not be overwritten by CE (BUY) feed',
    );
  });
});

