import { test } from 'node:test';
import assert from 'node:assert';
import { parseTradingViewMessage } from '../src/signals/parseTradingViewMessage.js';
import {
  mapIndianOptionSymbol,
  normalizeInstrumentSymbol,
} from '../src/signals/tradingviewServer.js';

test('parseTradingViewMessage parses Accepted Entry/Exit correctly', () => {
  const { side, action } = parseTradingViewMessage(
    'Accepted Entry + priorRisePct=0.00 | sym=BTCUSDT',
  );
  assert.strictEqual(side, 'BUY');
  assert.strictEqual(action, 'ENTRY');

  const { side: side2, action: action2 } = parseTradingViewMessage(
    'Accepted Exit + priorRisePct=0.00 | sym=NIFTY',
  );
  assert.strictEqual(side2, 'SELL');
  assert.strictEqual(action2, 'EXIT');
});

test('mapIndianOptionSymbol maps TradingView symbols to Fyers option contracts', () => {
  const ce = mapIndianOptionSymbol('NIFTY241024C22000');
  assert.ok(ce);
  assert.ok(ce.fyersSymbol.includes('NIFTY'));
  assert.strictEqual(ce.optionType, 'CALL');

  const pe = mapIndianOptionSymbol('BANKNIFTY241024P48000');
  assert.ok(pe);
  assert.ok(pe.fyersSymbol.startsWith('NSE:BANKNIFTY'));
  assert.strictEqual(pe.optionType, 'PUT');

  const sensex = mapIndianOptionSymbol('BSX241024C72000');
  assert.ok(sensex);
  assert.ok(sensex.fyersSymbol.startsWith('BSE:SENSEX'));
  assert.strictEqual(sensex.optionType, 'CALL');
});

test('normalizeInstrumentSymbol returns expected info for Indian options and non-Indian symbols', () => {
  const niftyInfo = normalizeInstrumentSymbol('NIFTY', 'NIFTY241024C22000');
  assert.ok(niftyInfo);
  assert.ok(niftyInfo.fyersSymbol.includes('NIFTY'));
  assert.strictEqual(niftyInfo.optionType, 'CALL');

  const bankniftyInfo = normalizeInstrumentSymbol(
    'BANKNIFTY',
    'BANKNIFTY241024P48000',
  );
  assert.ok(bankniftyInfo);
  assert.ok(bankniftyInfo.fyersSymbol.startsWith('NSE:BANKNIFTY'));
  assert.strictEqual(bankniftyInfo.optionType, 'PUT');

  const plainEquity = normalizeInstrumentSymbol('BTCUSDT', 'RELIANCE');
  assert.ok(plainEquity);
  assert.strictEqual(plainEquity.optionType, null);
  assert.ok(plainEquity.fyersSymbol.startsWith('NSE:'));
});
