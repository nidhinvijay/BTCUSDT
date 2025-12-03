
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

async function testIndianPE() {
  console.log('--- Testing Indian PE Logic ---');
  const symbol = 'NIFTY50';
  const signalBus = createSignalBus();
  const pnlContext = createPnlContext({ symbol });

  const fsm = createFSM({
    symbol,
    signalBus,
    broker: mockBroker,
    pnlContext,
    logger
  });

  // 1. Send SELL signal (for PE)
  console.log('1. Sending SELL signal...');
  signalBus.emitSell({ action: 'SELL', source: 'Test' });

  // 2. Feed first tick to set triggers
  // LTP = 100. For Indian PE (Long), trigger should be 100 + 0.5 = 100.5
  console.log('2. Feeding first tick (LTP=100)...');
  fsm.onTick({ ltp: 100, ts: Date.now(), source: 'sell' });

  const state = fsm.getState();
  console.log(`State after first tick: ${state.sellState}`);
  console.log(`Trigger: ${state.sellEntryTrigger}`);
  console.log(`Stop: ${state.sellStop}`);

  if (state.sellEntryTrigger !== 100.5) {
    console.error('FAIL: Trigger should be 100.5 (Long logic)');
  } else {
    console.log('PASS: Trigger is correct (Long logic)');
  }

  // 3. Feed tick below trigger (should NOT enter)
  console.log('3. Feeding tick 100.2 (Below trigger)...');
  fsm.onTick({ ltp: 100.2, ts: Date.now() + 1000, source: 'sell' });
  if (fsm.getShortPosition()) {
    console.error('FAIL: Should not have entered yet');
  } else {
    console.log('PASS: Did not enter yet');
  }

  // 4. Feed tick above trigger (should ENTER)
  console.log('4. Feeding tick 100.6 (Above trigger)...');
  fsm.onTick({ ltp: 100.6, ts: Date.now() + 2000, source: 'sell' });
  
  const pos = fsm.getShortPosition();
  if (pos && pos.qty > 0) {
    console.log('PASS: Entered position!');
    console.log('Position:', pos);
  } else {
    console.error('FAIL: Did not enter position');
  }

  // 5. Feed tick below stop (should STOP LOSS)
  // Stop is 100 - 0.5 = 99.5
  console.log('5. Feeding tick 99.0 (Below stop)...');
  fsm.onTick({ ltp: 99.0, ts: Date.now() + 3000, source: 'sell' });

  if (!fsm.getShortPosition()) {
    console.log('PASS: Stopped out correctly');
  } else {
    console.error('FAIL: Did not stop out');
  }
}

testIndianPE().catch(console.error);
