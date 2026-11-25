// 로컬 서버를 띄워 HTTP API와 실시간 채팅(WebSocket)을 자동으로 확인합니다.
// 실행: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = 3999;
const BASE = `http://localhost:${PORT}/api`;
const WS = `ws://localhost:${PORT}/ws`;
let server;

before(async () => {
  server = spawn(process.execPath, [fileURLToPath(new URL("../local/server.mjs", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((ok) => server.stdout.once("data", ok));
});
after(() => server?.kill());

const post = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(cardId, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?cardId=${cardId}&name=${encodeURIComponent(name)}`);
    ws.inbox = [];
    ws.on("message", (d) => ws.inbox.push(JSON.parse(d)));
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    ws.on("error", reject);
  });
}

test("카드 생성과 조회", async () => {
  const r = await post("/cards", { prompt: "질문", answer: "답변", memo: "메모", aiTool: "Claude" });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  const card = await (await fetch(`${BASE}/cards/${id}`)).json();
  assert.equal(card.prompt, "질문");
  assert.equal(card.title, "질문"); // 제목이 없으면 프롬프트 첫 줄
});

test("입력 검증", async () => {
  assert.equal((await post("/cards", { prompt: "질문만" })).status, 400);
  assert.equal((await post("/cards", { prompt: "p", answer: "a", memo: "x".repeat(2001) })).status, 400);
  const bad = await fetch(BASE + "/cards", { method: "POST", body: "not json" });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${BASE}/cards/abcdefghij`)).status, 404);
});

test("실시간 채팅: 메시지 전달, 접속자, 기록", async () => {
  const { id } = await (await post("/cards", { prompt: "p", answer: "a" })).json();
  const a = await connect(id, "재엽");
  const b = await connect(id, "가윤");
  a.send(JSON.stringify({ type: "hello" }));
  await sleep(150);
  const presence = b.inbox.find((m) => m.type === "presence");
  assert.equal(presence.online, 2);

  a.send(JSON.stringify({ type: "message", text: "안녕", clientId: "A" }));
  await sleep(150);
  const got = b.inbox.find((m) => m.type === "message");
  assert.equal(got.message.text, "안녕");
  assert.equal(got.message.name, "재엽");

  const { messages } = await (await fetch(`${BASE}/cards/${id}/messages`)).json();
  assert.deepEqual(messages.map((m) => m.text), ["안녕"]);

  b.close();
  await sleep(150);
  assert.equal(a.inbox.at(-1).online, 1);
  a.close();
});

test("없는 카드의 채팅방은 연결 거부", async () => {
  await assert.rejects(connect("zzzzzzzzzz", "x"), /404/);
});
