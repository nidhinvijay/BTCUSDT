// src/signals/tradingviewServer.js
import express from "express";
import { config } from "../config/env.js";
import { parseTradingViewMessage } from "./parseTradingViewMessage.js";

const relays = new Set();

// If your Node version does NOT have global fetch:
// import fetch from 'node-fetch';

async function broadcastToRelays(event, logger) {
  const RELAY_TIMEOUT_MS = 5000; // 5 second timeout

  const promises = Array.from(relays).map(async (url) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Get error response body to understand what went wrong
        const errorText = await response.text().catch(() => "No error body");
        logger.warn(
          { url, status: response.status, errorBody: errorText },
          "Relay responded with error status"
        );
      } else {
        logger.debug({ url }, "Relay broadcast successful");
      }
    } catch (err) {
      if (err.name === "AbortError") {
        logger.error({ url, timeout: RELAY_TIMEOUT_MS }, "Relay POST timeout");
      } else {
        logger.error({ err, url }, "Relay POST failed");
      }
    }
  });

  // Fire and forget - don't wait for all relays
  Promise.allSettled(promises);
}

export function startTradingViewServer({ signalBus, fsm, pnlContext, logger }) {
  const app = express();

  // Accept JSON and RAW TEXT
  app.use(express.json({ limit: "2mb" }));
  app.use(express.text({ type: "*/*", limit: "2mb" }));

  // -----------------------------
  //  Webhook (JSON OR raw text)
  // -----------------------------
  app.post("/webhook", async (req, res) => {
    let raw = req.body;
    let body = raw;
    let message = null;

    // STEP 1 — If raw is a string, attempt JSON parse
    if (typeof raw === "string") {
      const trimmed = raw.trim();

      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          body = JSON.parse(trimmed);
        } catch {
          body = trimmed; // fallback to raw text
        }
      } else {
        body = trimmed; // pure text message
      }
    }

    // STEP 2 — Extract message
    if (typeof body === "string") {
      message = body.trim();
    } else if (body && typeof body === "object") {
      message = body.message ?? body.text ?? body.signal ?? null;
    }

    // STEP 3 — Must be valid text
    if (!message || typeof message !== "string") {
      logger.warn({ raw }, "Webhook without usable message text");
      return res.status(400).json({ error: "Missing message text" });
    }

    // STEP 4 — Parse into BUY/SELL
    const { side } = parseTradingViewMessage(message);

    if (!side) {
      logger.warn({ message }, "Unknown TradingView message format");
      return res.status(400).json({ error: "Unknown message format" });
    }

    logger.info({ side, message }, "Received TradingView signal");

    // Emit BUY/SELL internally
    if (side === "BUY") signalBus.emitBuy();
    if (side === "SELL") signalBus.emitSell();

    // Respond immediately, then relay asynchronously
    res.json({ status: "ok" });

    // Relay to external endpoints (async, non-blocking)
    broadcastToRelays(
      {
        message: message, // Send in webhook-compatible format
        type: "tradingview-signal",
        side,
        rawMessage: message,
        ts: Date.now(),
      },
      logger
    );
  });

  // ------------------------------------------------------------
  //  Status API (FSM state, anchors, PnL, position)
  // ------------------------------------------------------------
  app.get("/status", (req, res) => {
    const buyState = fsm?.getBuyState?.() ?? "UNKNOWN";
    const sellState = fsm?.getSellState?.() ?? "UNKNOWN";
    const longPosition = fsm?.getLongPosition?.() ?? null;
    const shortPosition = fsm?.getShortPosition?.() ?? null;
    const anchors = fsm?.getAnchors?.() ?? null;
    const signalHistory = fsm?.getSignalHistory?.() ?? [];
    const pnl = pnlContext?.getSnapshot?.() ?? null;

    res.json({
      buyState,
      sellState,
      longPosition,
      shortPosition,
      anchors,
      signalHistory,
      pnl,
    });
  });

  // ------------------------------------------------------------
  //  Dashboard UI HTML
  // ------------------------------------------------------------
  app.get("/", (req, res) => {
    res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>${config.symbol} Paper Trader Dashboard</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0; padding: 16px;
            font-family: system-ui;
            background: #050509; color: #f5f5f5;
          }
          h1 { margin-top: 0; font-size: 24px; }
          .sub { color: #9a9a9a; font-size: 12px; margin-bottom: 12px; }
          .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 16px; margin-bottom: 16px; }
          .card { background: #15151b; border-radius: 12px; padding: 16px; box-shadow: 0 0 12px rgba(0,0,0,0.45); }
          .label { font-size: 11px; text-transform: uppercase; color: #9a9a9a; margin-bottom: 4px; letter-spacing: 0.08em; }
          .value { font-size: 18px; }
          .pnl-pos { color: #2ecc71; }
          .pnl-neg { color: #e74c3c; }
          table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
          th, td { padding: 4px 6px; border-bottom: 1px solid #222; text-align: left; }
          th { font-weight: 600; color: #bbbbbb; }
          .relay-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #222; font-size: 12px; }
          button { border-radius: 6px; border: 1px solid #444; background: #1f1f27; color: #f5f5f5; padding: 4px 8px; cursor: pointer; font-size: 12px; }
          button:hover { background: #2a2a34; }
          input { width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid #444; background: #0b0b11; color: #f5f5f5; font-size: 12px; margin-bottom: 6px; }
          .small { font-size: 11px; color: #9a9a9a; margin-top: 4px; }
        </style>
      </head>
      <body>
      <h1>${config.symbol} Paper Trader</h1>
      <div class="sub">Dashboard · FSM state, position, anchors, P&L and relays</div>
      <div id="cards">Loading...</div>

      <div class="grid">
        <div class="card" style="grid-column:1/-1;">
          <div class="label">Trades</div>
          <div id="trades-table">No trades yet.</div>
        </div>

        <div class="card" style="grid-column:1/-1;">
          <div class="label">Signal History (Last 10)</div>
          <div id="signals-table">No signals yet.</div>
        </div>

        <div class="card" style="grid-column:1/-1;">
          <div class="label">Relays</div>
          <input id="relay-url" type="text" placeholder="https://your-endpoint.example.com/hook">
          <button id="add-relay-btn">Add Relay</button>
          <div class="small">All TradingView signals will be forwarded to these URLs.</div>
          <div id="relays-list" style="margin-top:8px;">Loading relays...</div>
        </div>
      </div>

      <script>
        function fmt(v){ return v==null?'-':Number(v).toFixed(2); }
        function cls(v){ return v>0?'pnl-pos':v<0?'pnl-neg':''; }

        async function status(){ return (await fetch('/status')).json(); }
        async function relays(){ return (await fetch('/relays')).json(); }
        async function addRelay(url){ return (await fetch('/relays',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})})).json(); }
        async function rmRelay(url){ return (await fetch('/relays',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})})).json(); }

        function renderCards(d){
          const p=d.pnl||{}, lp=d.longPosition||{}, sp=d.shortPosition||{}, a=d.anchors||{};
          document.getElementById('cards').innerHTML = '<div class="grid">' +
            '<div class="card"><div class="label">BUY FSM State</div><div class="value">' + d.buyState + '</div></div>' +
            '<div class="card"><div class="label">SELL FSM State</div><div class="value">' + d.sellState + '</div></div>' +
            '<div class="card"><div class="label">LONG Position</div>' +
            '<div>Side: ' + (lp.side||'-') + '</div><div>Qty: ' + (lp.qty||0) + '</div>' +
            '<div>Entry: ' + (lp.entryPrice||'-') + '</div></div>' +
            '<div class="card"><div class="label">SHORT Position</div>' +
            '<div>Side: ' + (sp.side||'-') + '</div><div>Qty: ' + (sp.qty||0) + '</div>' +
            '<div>Entry: ' + (sp.entryPrice||'-') + '</div></div>' +
            '<div class="card"><div class="label">Anchors</div>' +
            '<div>Buy Trigger: ' + (a.buyEntryTrigger??'-') + '</div>' +
            '<div>Buy Stop: ' + (a.buyStop??'-') + '</div>' +
            '<div>Sell Trigger: ' + (a.sellEntryTrigger??'-') + '</div>' +
            '<div>Sell Stop: ' + (a.sellStop??'-') + '</div></div>' +
            '<div class="card"><div class="label">P&L</div>' +
            '<div>Side: ' + (p.positionSide||'None') + '</div>' +
            '<div>Qty: ' + (p.positionQty||0) + '</div>' +
            '<div>Avg Price: ' + (p.avgPrice?p.avgPrice.toFixed(2):'-') + '</div>' +
            '<div>Last: ' + (p.lastPrice||'-') + '</div>' +
            '<div class="' + cls(p.realizedPnl) + '">Realized: ' + fmt(p.realizedPnl) + '</div>' +
            '<div class="' + cls(p.unrealizedPnl) + '">Unrealized: ' + fmt(p.unrealizedPnl) + '</div>' +
            '<div class="' + cls(p.totalPnl) + '">Total: ' + fmt(p.totalPnl) + '</div>' +
            '<div>Trades: ' + (p.tradeCount||0) + '</div>' +
            '</div></div>';
        }

        function renderTrades(p){
          const h=document.getElementById('trades-table');
          const t=(p&&p.trades)||[];
          if(!t.length){ h.textContent='No trades yet.'; return; }
          h.innerHTML = '<table><thead><tr><th>Time</th><th>Type</th><th>Side</th><th>Qty</th><th>Price</th><th>P&L</th></tr></thead><tbody>' +
            t.slice().reverse().map(r=>{
              const ts=new Date(r.ts).toLocaleString();
              return \`<tr><td>\${ts}</td><td>\${r.type}</td><td>\${r.side}</td><td>\${r.qty}</td><td>\${r.price}</td><td class="\${cls(r.pnl)}">\${fmt(r.pnl)}</td></tr>\`;
            }).join('') + '</tbody></table>';
        }

        function renderSignals(s){
          const h=document.getElementById('signals-table');
          const list=s||[];
          if(!list.length){ h.textContent='No signals yet.'; return; }
          h.innerHTML = '<table><thead><tr><th>Time</th><th>Side</th><th>FSM State</th></tr></thead><tbody>' +
            list.map(r=>{
              const ts=new Date(r.ts).toLocaleString();
              const sideClass=r.side==='BUY'?'pnl-pos':'pnl-neg';
              return \`<tr><td>\${ts}</td><td class="\${sideClass}">\${r.side}</td><td>\${r.state}</td></tr>\`;
            }).join('') + '</tbody></table>';
        }

        function renderRelays(d){
          const h=document.getElementById('relays-list');
          const list=d.relays||[];
          if(!list.length){ h.textContent='No relays registered.'; return; }
          h.innerHTML=list.map(u=>\`<div class="relay-row"><div>\${u}</div><button data-url="\${u}">Remove</button></div>\`).join('');
          h.querySelectorAll('button').forEach(btn=>{
            btn.onclick=async ()=>{ await rmRelay(btn.dataset.url); renderRelays(await relays()); };
          });
        }

        async function refresh(){
          const [s,r]=await Promise.all([status(),relays()]);
          renderCards(s); renderSignals(s.signalHistory); renderTrades(s.pnl); renderRelays(r);
        }

        document.addEventListener('DOMContentLoaded',()=>{
          document.getElementById('add-relay-btn').onclick=async ()=>{
            const url=document.getElementById('relay-url').value.trim();
            if(url){ await addRelay(url); document.getElementById('relay-url').value=''; renderRelays(await relays()); }
          };
          refresh(); setInterval(refresh,2000);
        });
      </script>
      </body></html>
    `);
  });

  // Relay Management API
  app.get("/relays", (req, res) => res.json({ relays: [...relays] }));
  app.post("/relays", (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url is required" });

    // Validate URL format
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({ error: "URL must use HTTP or HTTPS" });
      }
    } catch (err) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    relays.add(url);
    logger.info({ url }, "Added relay URL");
    res.json({ ok: true, relays: [...relays] });
  });
  app.delete("/relays", (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url is required" });
    relays.delete(url);
    logger.info({ url }, "Removed relay URL");
    res.json({ ok: true, relays: [...relays] });
  });

  app.listen(config.port, () => {
    logger.info(
      `TradingView webhook server + dashboard listening on port ${config.port}`
    );
  });
}
