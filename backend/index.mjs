// 🏃 바톤 백엔드 — Lambda 함수 하나로 HTTP API와 WebSocket(실시간 채팅)을 모두 처리합니다.
// 런타임: Node.js 24.x (AWS SDK v3는 Lambda에 기본 포함)
//
// HTTP API (API Gateway HTTP API)
//   POST /cards                 카드 생성 → { id }
//   GET  /cards/{id}            카드 조회
//   GET  /cards/{id}/messages   채팅 기록 (최근 100개)
//
// WebSocket API (API Gateway WebSocket API)
//   $connect     ?cardId=...&name=...   카드 채팅방 입장
//   $disconnect                         퇴장
//   $default     { type: "message", text, clientId }  메시지 보내기
//                { type: "hello" }                    접속자 목록 갱신 요청
//                { type: "ping" }                     연결 유지용
//
// 서버 → 브라우저
//   { type: "message", message: {...} }
//   { type: "presence", online: 2, names: ["재엽", "가윤"] }
//
// 환경 변수: CARDS_TABLE, MESSAGES_TABLE, CONNECTIONS_TABLE

import { randomBytes } from "node:crypto";

// ---------------- 공통 ----------------
const CARD_LIMITS = { title: 120, prompt: 30000, answer: 60000, memo: 2000, aiTool: 40, author: 40 };
const CARD_LABELS = { title: "제목", prompt: "프롬프트", answer: "AI 답변", memo: "메모", aiTool: "사용한 AI", author: "작성자" };
const REQUIRED = ["prompt", "answer"];
const MESSAGE_MAX = 2000;
const NAME_MAX = 20;
const HISTORY_LIMIT = 100;
const CONNECTION_TTL_SEC = 2 * 60 * 60; // 끊긴 연결 기록은 2시간 뒤 자동 삭제(DynamoDB TTL)
const ID_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ID_RE = /^[A-Za-z0-9]{6,20}$/;

export function newId(len = 10) {
  let id = "";
  for (const b of randomBytes(len)) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

export function validateCard(body) {
  if (!body || typeof body !== "object") return { error: "요청 형식이 올바르지 않습니다." };
  const card = {};
  for (const [key, max] of Object.entries(CARD_LIMITS)) {
    const raw = body[key];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return { error: `${CARD_LABELS[key]} 값이 올바르지 않습니다.` };
    }
    const value = (raw ?? "").trim();
    if (value.length > max) return { error: `${CARD_LABELS[key]}은(는) ${max.toLocaleString()}자 이하로 입력해 주세요.` };
    card[key] = value;
  }
  for (const key of REQUIRED) {
    if (!card[key]) return { error: `${CARD_LABELS[key]}을 입력해 주세요.` };
  }
  if (!card.title) card.title = card.prompt.split("\n")[0].slice(0, 60);
  return { card };
}

export function cleanName(name) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return n || "익명";
}

// 같은 밀리초에 온 메시지도 순서가 유지되도록 정렬 키를 만든다
function messageSortKey(now = Date.now()) {
  return `${String(now).padStart(13, "0")}#${newId(4)}`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function bodyText(event) {
  return event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
}

// ---------------- 앱 (저장소·전송 함수를 주입받아 로컬/AWS 공용) ----------------
// store: putCard, getCard, putMessage, listMessages, putConnection, getConnection,
//        deleteConnection, listConnections(cardId)
// send(connectionId, data, event) → 연결이 끊겼으면 false
export function makeApp({ store, send }) {
  const CORS = {
    "Access-Control-Allow-Origin": process.env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
  const res = (statusCode, data) => ({
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify(data),
  });

  // ---- HTTP ----
  async function http(event) {
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.rawPath || event.path || "";
    try {
      if (method === "OPTIONS") return res(204, {});

      if (method === "POST" && /\/cards\/?$/.test(path)) {
        const body = parseJson(bodyText(event));
        if (body === undefined) return res(400, { error: "JSON 형식이 올바르지 않습니다." });
        const { card, error } = validateCard(body);
        if (error) return res(400, { error });
        const item = { id: newId(), ...card, createdAt: new Date().toISOString() };
        await store.putCard(item);
        console.log("card created", item.id);
        return res(201, { id: item.id });
      }

      let m = path.match(/\/cards\/([A-Za-z0-9]{6,20})\/messages\/?$/);
      if (method === "GET" && m) {
        if (!(await store.getCard(m[1]))) return res(404, { error: "카드를 찾을 수 없습니다." });
        const messages = await store.listMessages(m[1], HISTORY_LIMIT);
        return res(200, { messages });
      }

      m = path.match(/\/cards\/([A-Za-z0-9]{6,20})\/?$/);
      if (method === "GET" && m) {
        const item = await store.getCard(m[1]);
        if (!item) return res(404, { error: "카드를 찾을 수 없습니다. 링크를 다시 확인해 주세요." });
        return res(200, item);
      }

      return res(404, { error: "지원하지 않는 요청입니다." });
    } catch (err) {
      console.error("http error", err);
      return res(500, { error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
    }
  }

  // ---- WebSocket ----
  async function broadcast(cardId, data, event) {
    const conns = await store.listConnections(cardId);
    await Promise.all(
      conns.map(async (c) => {
        const ok = await send(c.connectionId, data, event);
        if (!ok) await store.deleteConnection(c.connectionId); // 끊긴 연결 정리
      })
    );
  }

  async function presence(cardId, event) {
    const conns = await store.listConnections(cardId);
    const names = [...new Set(conns.map((c) => c.name))];
    await broadcast(cardId, { type: "presence", online: conns.length, names }, event);
  }

  async function ws(event) {
    const { eventType, connectionId } = event.requestContext;
    try {
      if (eventType === "CONNECT") {
        const q = event.queryStringParameters || {};
        if (!ID_RE.test(q.cardId || "")) return { statusCode: 400, body: "cardId가 필요합니다." };
        if (!(await store.getCard(q.cardId))) return { statusCode: 404, body: "카드를 찾을 수 없습니다." };
        await store.putConnection({
          connectionId,
          cardId: q.cardId,
          name: cleanName(q.name),
          ttl: Math.floor(Date.now() / 1000) + CONNECTION_TTL_SEC,
        });
        return { statusCode: 200, body: "connected" };
      }

      if (eventType === "DISCONNECT") {
        const conn = await store.getConnection(connectionId);
        await store.deleteConnection(connectionId);
        if (conn) await presence(conn.cardId, event);
        return { statusCode: 200, body: "bye" };
      }

      // MESSAGE ($default)
      const conn = await store.getConnection(connectionId);
      if (!conn) return { statusCode: 410, body: "다시 연결해 주세요." };
      const data = parseJson(bodyText(event)) || {};

      if (data.type === "ping") return { statusCode: 200, body: "pong" };
      if (data.type === "hello") {
        await presence(conn.cardId, event);
        return { statusCode: 200, body: "ok" };
      }
      if (data.type === "message") {
        const text = String(data.text ?? "").trim();
        if (!text) return { statusCode: 400, body: "빈 메시지" };
        if (text.length > MESSAGE_MAX) {
          await send(connectionId, { type: "error", error: `메시지는 ${MESSAGE_MAX.toLocaleString()}자 이하로 보내 주세요.` }, event);
          return { statusCode: 400, body: "too long" };
        }
        const now = Date.now();
        const message = {
          cardId: conn.cardId,
          sk: messageSortKey(now),
          id: newId(8),
          name: conn.name,
          clientId: String(data.clientId ?? "").slice(0, 40),
          text,
          createdAt: new Date(now).toISOString(),
        };
        await store.putMessage(message);
        await broadcast(conn.cardId, { type: "message", message }, event);
        return { statusCode: 200, body: "sent" };
      }
      return { statusCode: 400, body: "알 수 없는 요청" };
    } catch (err) {
      console.error("ws error", err);
      return { statusCode: 500, body: "server error" };
    }
  }

  return { http, ws };
}

// ---------------- AWS 연결 (Lambda에서만 로드) ----------------
let awsApp;
async function getAwsApp() {
  if (awsApp) return awsApp;
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const { ApiGatewayManagementApiClient, PostToConnectionCommand } = await import("@aws-sdk/client-apigatewaymanagementapi");

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const CARDS = process.env.CARDS_TABLE || process.env.TABLE_NAME;
  const MESSAGES = process.env.MESSAGES_TABLE;
  const CONNS = process.env.CONNECTIONS_TABLE;

  const store = {
    putCard: (Item) => doc.send(new PutCommand({ TableName: CARDS, Item, ConditionExpression: "attribute_not_exists(id)" })),
    getCard: async (id) => (await doc.send(new GetCommand({ TableName: CARDS, Key: { id } }))).Item,
    putMessage: (Item) => doc.send(new PutCommand({ TableName: MESSAGES, Item })),
    listMessages: async (cardId, limit) => {
      const out = await doc.send(new QueryCommand({
        TableName: MESSAGES,
        KeyConditionExpression: "cardId = :c",
        ExpressionAttributeValues: { ":c": cardId },
        ScanIndexForward: false, // 최신부터 limit개
        Limit: limit,
      }));
      return (out.Items || []).reverse();
    },
    putConnection: (Item) => doc.send(new PutCommand({ TableName: CONNS, Item })),
    getConnection: async (connectionId) => (await doc.send(new GetCommand({ TableName: CONNS, Key: { connectionId } }))).Item,
    deleteConnection: (connectionId) => doc.send(new DeleteCommand({ TableName: CONNS, Key: { connectionId } })),
    listConnections: async (cardId) => {
      const out = await doc.send(new QueryCommand({
        TableName: CONNS,
        IndexName: "byCard",
        KeyConditionExpression: "cardId = :c",
        ExpressionAttributeValues: { ":c": cardId },
      }));
      return out.Items || [];
    },
  };

  const clients = new Map();
  async function send(connectionId, data, event) {
    const { domainName, stage } = event.requestContext;
    const endpoint = `https://${domainName}/${stage}`;
    if (!clients.has(endpoint)) clients.set(endpoint, new ApiGatewayManagementApiClient({ endpoint }));
    try {
      await clients.get(endpoint).send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(data)),
      }));
      return true;
    } catch (err) {
      if (err.name === "GoneException" || err.$metadata?.httpStatusCode === 410) return false;
      throw err;
    }
  }

  awsApp = makeApp({ store, send });
  return awsApp;
}

export const handler = async (event) => {
  const app = await getAwsApp();
  return event.requestContext?.eventType ? app.ws(event) : app.http(event);
};
