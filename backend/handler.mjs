// 랍스터 — AI 대화 공유 카드 API (Sprint 1)
// 경로:
//   POST /cards       카드 생성 → { id }
//   GET  /cards/{id}  카드 조회
// 런타임: AWS Lambda Node.js 20.x (AWS SDK v3 기본 포함)

import { randomBytes } from "node:crypto";

const LIMITS = {
  title: 120,
  prompt: 30000,
  answer: 60000,
  memo: 2000,
  aiTool: 40,
  author: 40,
};
const REQUIRED = ["prompt", "answer"];
const LABELS = {
  title: "제목", prompt: "프롬프트", answer: "AI 답변",
  memo: "메모", aiTool: "사용한 AI", author: "작성자",
};
const ID_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newId(len = 10) {
  const bytes = randomBytes(len);
  let id = "";
  for (const b of bytes) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

export function validateCard(body) {
  if (!body || typeof body !== "object") return { error: "요청 형식이 올바르지 않습니다." };
  const card = {};
  for (const [key, max] of Object.entries(LIMITS)) {
    const raw = body[key];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return { error: `${LABELS[key]} 값이 올바르지 않습니다.` };
    }
    const value = (raw ?? "").trim();
    if (value.length > max) return { error: `${LABELS[key]}은(는) ${max.toLocaleString()}자 이하로 입력해 주세요.` };
    card[key] = value;
  }
  for (const key of REQUIRED) {
    if (!card[key]) {
      return { error: `${LABELS[key]}을 입력해 주세요.` };
    }
  }
  if (!card.title) card.title = card.prompt.split("\n")[0].slice(0, 60);
  return { card };
}

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOW_ORIGIN || "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function res(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify(data),
  };
}

// store: { put(item), get(id) } — 배포 시 DynamoDB, 로컬 시험 시 메모리
export function makeHandler(store) {
  return async (event) => {
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.rawPath || event.path || "";

    try {
      if (method === "OPTIONS") return res(204, {});

      if (method === "POST" && /\/cards\/?$/.test(path)) {
        let body;
        try {
          const text = event.isBase64Encoded
            ? Buffer.from(event.body || "", "base64").toString("utf8")
            : event.body || "";
          body = JSON.parse(text);
        } catch {
          return res(400, { error: "JSON 형식이 올바르지 않습니다." });
        }
        const { card, error } = validateCard(body);
        if (error) return res(400, { error });

        const item = { id: newId(), ...card, createdAt: new Date().toISOString() };
        await store.put(item);
        console.log("card created", item.id);
        return res(201, { id: item.id });
      }

      const match = path.match(/\/cards\/([A-Za-z0-9]{6,20})\/?$/);
      if (method === "GET" && match) {
        const item = await store.get(match[1]);
        if (!item) return res(404, { error: "카드를 찾을 수 없습니다. 링크를 다시 확인해 주세요." });
        return res(200, item);
      }

      return res(404, { error: "지원하지 않는 요청입니다." });
    } catch (err) {
      console.error("handler error", err);
      return res(500, { error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
    }
  };
}

// ---- DynamoDB 저장소 (Lambda에서만 로드) ----
let dynamoStore;
async function getDynamoStore() {
  if (dynamoStore) return dynamoStore;
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, PutCommand, GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const TableName = process.env.TABLE_NAME;
  dynamoStore = {
    put: (Item) =>
      doc.send(new PutCommand({ TableName, Item, ConditionExpression: "attribute_not_exists(id)" })),
    get: async (id) => (await doc.send(new GetCommand({ TableName, Key: { id } }))).Item,
  };
  return dynamoStore;
}

export const handler = async (event) => makeHandler(await getDynamoStore())(event);
