
import { test } from 'node:test';
import assert from 'node:assert';
import { createPnlContext } from '../src/trading/pnlContext.js';

test('PnL Context Logic', async (t) => {
  
  await t.test('Basic Long Trade PnL', () => {
    const pnl = createPnlContext({ symbol: 'BTCUSDT' });
    
    // Open Long 1 BTC @ 50000
    pnl.openPosition({ side: 'BUY', qty: 1, price: 50000 });
    
    // Update Price to 51000 (Unrealized +1000)
    let snap = pnl.updateMarkPrice(51000);
    assert.strictEqual(snap.unrealizedPnl, 1000);
    assert.strictEqual(snap.realizedPnl, 0);
    
    // Close Long @ 52000 (Realized +2000)
    snap = pnl.closePosition({ side: 'SELL', qty: 1, price: 52000 });
    assert.strictEqual(snap.realizedPnl, 2000);
    assert.strictEqual(snap.unrealizedPnl, 0);
    assert.strictEqual(snap.longStats.realizedPnl, 2000);
    assert.strictEqual(snap.shortStats.realizedPnl, 0);
  });

  await t.test('Basic Short Trade PnL', () => {
    const pnl = createPnlContext({ symbol: 'BTCUSDT' });
    
    // Open Short 1 BTC @ 50000
    pnl.openPosition({ side: 'SELL', qty: 1, price: 50000 });
    
    // Update Price to 49000 (Unrealized +1000)
    let snap = pnl.updateMarkPrice(49000);
    assert.strictEqual(snap.unrealizedPnl, 1000);
    
    // Close Short @ 48000 (Realized +2000)
    snap = pnl.closePosition({ side: 'BUY', qty: 1, price: 48000 });
    assert.strictEqual(snap.realizedPnl, 2000);
    assert.strictEqual(snap.shortStats.realizedPnl, 2000);
    assert.strictEqual(snap.longStats.realizedPnl, 0);
  });

  await t.test('Mixed Trades & Metrics', () => {
    const pnl = createPnlContext({ symbol: 'BTCUSDT' });
    
    // Trade 1: Long Win (+100)
    pnl.openPosition({ side: 'BUY', qty: 1, price: 100 });
    pnl.closePosition({ side: 'SELL', qty: 1, price: 200 });
    
    // Trade 2: Short Loss (-50)
    pnl.openPosition({ side: 'SELL', qty: 1, price: 200 });
    pnl.closePosition({ side: 'BUY', qty: 1, price: 250 });
    
    const snap = pnl.getSnapshot();
    assert.strictEqual(snap.realizedPnl, 50); // 100 - 50
    assert.strictEqual(snap.metrics.winCount, 1);
    assert.strictEqual(snap.metrics.lossCount, 1);
    assert.strictEqual(snap.metrics.totalWins, 100);
    assert.strictEqual(snap.metrics.totalLosses, 50);
    assert.strictEqual(snap.metrics.profitFactor, 2.0); // 100 / 50
  });

});
