// 로컬 시험용 서버: AWS 없이 화면 + API를 함께 띄웁니다.
// 실행: node local/server.mjs  →  http://localhost:3000
// (저장은 메모리에만 되므로 서버를 끄면 카드가 사라집니다)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { makeHandler } from "../backend/handler.mjs";

const PORT = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL("../frontend/", import.meta.url));
const mem = new Map();
const handler = makeHandler({
  put: async (item) => void mem.set(item.id, item),
  get: async (id) => mem.get(id),
});
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname.startsWith("/api/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const out = await handler({
        rawPath: url.pathname.slice(4),
        requestContext: { http: { method: req.method } },
        body,
      });
      res.writeHead(out.statusCode, out.headers);
      return res.end(out.body);
    }

    if (url.pathname === "/config.js") {
      res.writeHead(200, { "Content-Type": TYPES[".js"] });
      return res.end(`window.LOBSTER_API_URL = "http://localhost:${PORT}/api";`);
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
  })
  .listen(PORT, () => console.log(`🦞 http://localhost:${PORT}`));
