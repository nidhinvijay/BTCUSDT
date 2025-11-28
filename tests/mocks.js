
import { EventEmitter } from 'events';

export class MockSignalBus extends EventEmitter {
  onBuy(cb) { this.on('buy', cb); }
  onSell(cb) { this.on('sell', cb); }
  triggerBuy() { this.emit('buy'); }
  triggerSell() { this.emit('sell'); }
  emitBuy() { this.emit('buy'); }
  emitSell() { this.emit('sell'); }
}

export class MockBroker {
  constructor() {
    this.orders = [];
  }

  placeLimitBuy(qty, price, meta) {
    this.orders.push({ type: 'BUY', qty, price, meta });
  }

  placeLimitSell(qty, price, meta) {
    this.orders.push({ type: 'SELL', qty, price, meta });
  }

  getOrders() {
    return this.orders;
  }
  
  clear() {
    this.orders = [];
  }

  isLive() {
    return false;
  }
}

export const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
