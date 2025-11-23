// src/utils/marketHours.js
// Check if markets are open based on symbol and current time

export function isMarketOpen(symbol) {
  const now = new Date();
  
  // Crypto markets (Binance) are 24/7
  if (symbol === 'BTCUSDT' || symbol.includes('USDT')) {
    return true;
  }
  
  // Indian markets (NSE/BSE)
  if (symbol === 'NIFTY' || symbol === 'BANKNIFTY' || symbol === 'SENSEX') {
    return isIndianMarketOpen(now);
  }
  
  // Default: assume open
  return true;
}

function isIndianMarketOpen(date) {
  // Convert to IST
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  
  const day = istTime.getDay(); // 0 = Sunday, 6 = Saturday
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  
  // Weekend check
  if (day === 0 || day === 6) {
    return false; // Closed on weekends
  }
  
  // Market hours: 9:15 AM - 3:30 PM IST
  const marketOpenTime = 9 * 60 + 15; // 9:15 AM in minutes
  const marketCloseTime = 15 * 60 + 30; // 3:30 PM in minutes
  const currentTime = hours * 60 + minutes;
  
  return currentTime >= marketOpenTime && currentTime < marketCloseTime;
}

export function getMarketStatus(symbol) {
  const isOpen = isMarketOpen(symbol);
  
  if (symbol === 'BTCUSDT') {
    return { isOpen: true, message: '24/7 Open' };
  }
  
  if (symbol === 'NIFTY' || symbol === 'BANKNIFTY' || symbol === 'SENSEX') {
    if (isOpen) {
      return { isOpen: true, message: 'Market Open (9:15 AM - 3:30 PM IST)' };
    } else {
      return { isOpen: false, message: 'Market Closed (Opens 9:15 AM IST)' };
    }
  }
  
  return { isOpen: true, message: 'Status Unknown' };
}

export function getNextMarketOpen(symbol) {
  if (symbol === 'BTCUSDT') {
    return null; // Always open
  }
  
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  
  let nextOpen = new Date(istTime);
  nextOpen.setHours(9, 15, 0, 0);
  
  // If past today's market hours, move to next trading day
  if (istTime.getHours() >= 15 && istTime.getMinutes() >= 30) {
    nextOpen.setDate(nextOpen.getDate() + 1);
  }
  
  // Skip weekends
  while (nextOpen.getDay() === 0 || nextOpen.getDay() === 6) {
    nextOpen.setDate(nextOpen.getDate() + 1);
  }
  
  return nextOpen;
}
