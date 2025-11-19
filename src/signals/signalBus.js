import { EventEmitter } from 'events';

export function createSignalBus() {
  const emitter = new EventEmitter();

  return {
    emitBuy(payload = {}) {
      emitter.emit('BUY', payload);
    },
    emitSell(payload = {}) {
      emitter.emit('SELL', payload);
    },
    onBuy(handler) {
      emitter.on('BUY', handler);
    },
    onSell(handler) {
      emitter.on('SELL', handler);
    }
  };
}
