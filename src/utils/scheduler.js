import { logger } from './logger.js';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';

export function startScheduler(activeBots) {
  logger.info("Scheduler started. Monitoring for market close times...");

  // Prevent multiple triggers within the same minute
  let lastTriggerMinute = -1;

  setInterval(() => {
    const now = new Date();
    // Convert to IST
    const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const currentMinuteKey = `${hours}:${minutes}`;

    if (currentMinuteKey === lastTriggerMinute) return;

    // 1. Indian Markets Close at 15:30 IST (3:30 PM)
    if (hours === 15 && minutes === 30) {
      logger.info("⏰ 15:30 IST - Triggering Reset for Indian Markets");
      ['NIFTY', 'BANKNIFTY', 'SENSEX'].forEach(symbol => {
        if (activeBots.has(symbol)) {
          triggerSymbolReset(symbol, activeBots.get(symbol));
        }
      });
      lastTriggerMinute = currentMinuteKey;
    }

    // 2. Crypto Daily Close at 05:30 IST (5:30 AM)
    if (hours === 5 && minutes === 30) {
      logger.info("⏰ 05:30 IST - Triggering Reset for Crypto Markets");
      ['BTCUSDT'].forEach(symbol => {
        if (activeBots.has(symbol)) {
          triggerSymbolReset(symbol, activeBots.get(symbol));
        }
      });
      lastTriggerMinute = currentMinuteKey;
    }

  }, 10000); // Check every 10 seconds
}

function triggerSymbolReset(symbol, bot) {
  try {
    logger.info(`[${symbol}] Initiating daily reset...`);

    // 1. Force Close Positions
    bot.fsm.manualCloseAll();

    // 2. Archive Data
    const filePath = path.resolve('data', `${symbol}.json`);
    if (fs.existsSync(filePath)) {
      const archiveDir = path.resolve('data', 'archive');
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = path.join(archiveDir, `${symbol}_${timestamp}.json`);
      fs.copyFileSync(filePath, archivePath);
      
      // 3. Delete State File
      fs.unlinkSync(filePath);
      logger.info(`[${symbol}] State file archived and deleted.`);
    }

    // 4. Reset Memory State (Soft Reset)
    bot.pnlContext.reset();
    bot.fsm.reset();
    
    logger.info(`[${symbol}] In-memory state reset. Ready for next session.`);

  } catch (err) {
    logger.error({ err, symbol }, "Failed to reset symbol");
  }
}
