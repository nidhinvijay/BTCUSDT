// src/utils/stateStore.js
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function upsertMachineState(symbol, state) {
  const filePath = path.join(DATA_DIR, `${symbol}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[StateStore] Failed to save state for ${symbol}:`, err);
  }
}

export function readMachineState(symbol) {
  const filePath = path.join(DATA_DIR, `${symbol}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      console.error(`[StateStore] Failed to read state for ${symbol}:`, err);
      return null;
    }
  }
  return null;
}
