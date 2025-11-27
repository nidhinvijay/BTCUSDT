// src/utils/resumer.js
import { readMachineState } from './stateStore.js';

export function resumeState(bots, symbol) {
  const savedState = readMachineState(symbol);
  if (!savedState) {
    return false;
  }

  console.log(`[Resumer] Found saved state for ${symbol}`);

  const restoreStack = (stack, snapshot) => {
    if (!stack || !snapshot) return;
    if (snapshot.fsm) {
      stack.fsm.restoreState(snapshot.fsm);
    }
    if (snapshot.pnl) {
      stack.pnlContext.restoreState(snapshot.pnl);
    }
  };

  if (savedState.paper) {
    restoreStack(bots.paper, savedState.paper);
  } else if (savedState.fsm || savedState.pnl) {
    // Legacy format
    restoreStack(bots.paper, { fsm: savedState.fsm, pnl: savedState.pnl });
  }

  if (savedState.live) {
    restoreStack(bots.live, savedState.live);
  }

  return true;
}
