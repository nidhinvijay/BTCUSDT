// src/config/env.js
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  symbol: process.env.SYMBOL || 'BTCUSDT',
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info'
};
