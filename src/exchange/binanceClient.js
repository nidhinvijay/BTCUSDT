import WebSocket from "ws";

export function connectTradeStream({ symbol, onMessage, onError, onClose }) {
  const lower = symbol.toLowerCase();
  const url = `wss://stream.binance.com:9443/ws/${lower}@trade`;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  const reconnectDelay = 5000; // 5 seconds
  let ws;
  let shouldReconnect = true;

  function connect() {
    ws = new WebSocket(url);

    ws.on("open", () => {
      console.log(`Connected to Binance trade stream for ${symbol}`);
      reconnectAttempts = 0; // Reset on successful connection
    });

    ws.on("message", (data) => {
      try {
        const json = JSON.parse(data.toString());
        onMessage && onMessage(json);
      } catch (err) {
        console.error("Error parsing Binance message", err);
      }
    });

    ws.on("error", (err) => {
      console.error("Binance WS error", err);
      onError && onError(err);
    });

    ws.on("close", (code, reason) => {
      console.warn(`Binance WS closed: ${code} ${reason}`);
      onClose && onClose(code, reason);

      // Attempt to reconnect if it wasn't a manual close
      if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        console.log(
          `Reconnecting to Binance (attempt ${reconnectAttempts}/${maxReconnectAttempts}) in ${reconnectDelay}ms...`
        );
        setTimeout(() => connect(), reconnectDelay);
      } else if (reconnectAttempts >= maxReconnectAttempts) {
        console.error("Max reconnection attempts reached. Giving up.");
      }
    });
  }

  connect();

  return {
    close: () => {
      shouldReconnect = false;
      ws.close();
    },
    get readyState() {
      return ws.readyState;
    },
  };
}
