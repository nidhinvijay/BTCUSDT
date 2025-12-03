
import { createFSM } from '../src/trading/fsm.js';
import { createSignalBus } from '../src/signals/signalBus.js';
import { createPnlContext } from '../src/trading/pnlContext.js';

// Mock logger
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Mock broker
const mockBroker = {
  placeLimitBuy: (qty, price, meta) => {
    console.log(`[MOCK] BUY ${qty} @ ${price}`, meta);
  },
  placeLimitSell: (qty, price, meta) => {
    console.log(`[MOCK] SELL ${qty} @ ${price}`, meta);
  },
  isLive: () => false
};

async function testCryptoShort() {
  console.log('--- Testing Crypto Short Logic (BTCUSDT) ---');
  const symbol = 'BTCUSDT'; // NOT Indian
  const signalBus = createSignalBus();
  const pnlContext = createPnlContext({ symbol });

  const fsm = createFSM({
    symbol,
    signalBus,
    broker: mockBroker,
    pnlContext,
    logger
  });

  // 1. Send SELL signal
  console.log('1. Sending SELL signal...');
  signalBus.emitSell({ action: 'SELL', source: 'Test' });

  // 2. Feed first tick to set triggers
  // LTP = 50000. For Short, trigger should be 50000 - 0.5 = 49999.5
  console.log('2. Feeding first tick (LTP=50000)...');
  fsm.onTick({ ltp: 50000, ts: Date.now(), source: 'base' });

  const state = fsm.getState();
  console.log(`State after first tick: ${state.sellState}`);
  console.log(`Trigger: ${state.sellEntryTrigger}`);
  console.log(`Stop: ${state.sellStop}`);

  if (state.sellEntryTrigger !== 49999.5) {
    console.error('FAIL: Trigger should be 49999.5 (Short logic)');
  } else {
    console.log('PASS: Trigger is correct (Short logic)');
  }

  // 3. Feed tick BELOW trigger (should ENTER immediately)
  // Note: FSM only checks first tick of the window.
  console.log('3. Feeding tick 49999 (Below trigger)...');
  fsm.onTick({ ltp: 49999, ts: Date.now() + 1000, source: 'base' });
  
  const pos = fsm.getShortPosition();
  if (pos && pos.qty > 0) {
    console.log('PASS: Entered position!');
    console.log('Position:', pos);
  } else {
    console.error('FAIL: Did not enter position');
  }
}

testCryptoShort().catch(console.error);
