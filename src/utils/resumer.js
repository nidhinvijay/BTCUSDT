// src/utils/resumer.js
import { readMachineState } from './stateStore.js';

export function resumeState(fsm, sessionManager, pnlContext, symbol) {
  const savedState = readMachineState(symbol);
  
  if (savedState) {
    console.log(`[Resumer] Found saved state for ${symbol}`);
    
    if (savedState.fsm) {
      fsm.restoreState(savedState.fsm);
    }
    
    if (savedState.session) {
      // Restore session state manually since SessionManager doesn't have a bulk restore
      // We assume sessionManager state structure matches saved structure
      Object.assign(sessionManager.state, savedState.session);
    }

    if (savedState.pnl && pnlContext) {
      pnlContext.restoreState(savedState.pnl);
    }
    
    return true;
  }
  
  return false;
}
