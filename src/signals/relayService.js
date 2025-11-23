import axios from 'axios';

const relays = new Set();

export async function broadcastToRelays(event, logger) {
  if (relays.size === 0) return;

  logger.info({ count: relays.size, event }, "Broadcasting to relays...");

  const promises = Array.from(relays).map(async (url) => {
    try {
      await axios.post(url, event, { timeout: 5000 });
      logger.info({ url }, "Relay sent successfully");
    } catch (err) {
      logger.error({ url, err: err.message }, "Relay failed");
    }
  });

  Promise.allSettled(promises);
}

export function addRelay(url) {
  relays.add(url);
}

export function removeRelay(url) {
  relays.delete(url);
}

export function getRelays() {
  return Array.from(relays);
}
