// 로컬 시험용 서버: AWS 없이 화면 + HTTP API + 실시간 채팅(WebSocket)을 한 번에 띄웁니다.
// 실행: npm install → npm run dev → http://localhost:3000
// (저장은 메모리에만 되므로 서버를 끄면 카드와 채팅이 사라집니다)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { makeApp } from "../backend/index.mjs";

const PORT = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL("../frontend/", import.meta.url));

// ---- 메모리 저장소 (DynamoDB 흉내) ----
const cards = new Map();
const messages = new Map(); // cardId → []
const conns = new Map(); // connectionId → { connectionId, cardId, name }
const store = {
  putCard: async (c) => void cards.set(c.id, c),
  getCard: async (id) => cards.get(id),
  putMessage: async (m) => {
    if (!messages.has(m.cardId)) messages.set(m.cardId, []);
    messages.get(m.cardId).push(m);
  },
  listMessages: async (cardId, limit) => (messages.get(cardId) || []).slice(-limit),
  putConnection: async (c) => void conns.set(c.connectionId, c),
  getConnection: async (id) => conns.get(id),
  deleteConnection: async (id) => void conns.delete(id),
  listConnections: async (cardId) => [...conns.values()].filter((c) => c.cardId === cardId),
};

// ---- WebSocket 전송 (API Gateway PostToConnection 흉내) ----
const sockets = new Map(); // connectionId → ws
async function send(connectionId, data) {
  const s = sockets.get(connectionId);
  if (!s || s.readyState !== s.OPEN) return false;
  s.send(JSON.stringify(data));
  return true;
}
const app = makeApp({ store, send });
const wsEvent = (eventType, connectionId, extra = {}) => ({ requestContext: { eventType, connectionId }, ...extra });

// ---- HTTP ----
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const out = await app.http({ rawPath: url.pathname.slice(4), requestContext: { http: { method: req.method } }, body });
    res.writeHead(out.statusCode, out.headers);
    return res.end(out.body);
  }

  if (url.pathname === "/config.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"] });
    return res.end(
      `window.LOBSTER_API_URL = "http://localhost:${PORT}/api";\nwindow.LOBSTER_WS_URL = "ws://localhost:${PORT}/ws";`
    );
  }

  const file = normalize(join(root, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// ---- WebSocket: API Gateway의 $connect / $default / $disconnect 흐름을 그대로 재현 ----
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/ws") return socket.destroy();
  const connectionId = randomUUID();
  const out = await app.ws(wsEvent("CONNECT", connectionId, { queryStringParameters: Object.fromEntries(url.searchParams) }));
  if (out.statusCode !== 200) {
    socket.write(`HTTP/1.1 ${out.statusCode} Rejected\r\n\r\n`);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.set(connectionId, ws);
    ws.on("message", (raw) => app.ws(wsEvent("MESSAGE", connectionId, { body: raw.toString() })));
    ws.on("close", async () => {
      sockets.delete(connectionId);
      await app.ws(wsEvent("DISCONNECT", connectionId));
    });
  });
});

server.listen(PORT, () => console.log(`🏃 http://localhost:${PORT}`));
