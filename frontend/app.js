// 바톤 프론트엔드 (Sprint 1)
// - ?id= 가 없으면 카드 작성 화면, 있으면 카드 보기 화면
(() => {
  const API = (window.LOBSTER_API_URL || "").replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);
  const MAX_URL_PROMPT = 6000; // 외부 AI로 넘길 때 URL에 담을 최대 글자 수

  // ---------- 공통 ----------
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 구형 브라우저/권한 거부 대비
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function renderMarkdown(el, text) {
    if (window.marked && window.DOMPurify) {
      el.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true }));
    } else {
      el.textContent = text; // CDN이 막혀도 내용은 보이게
      el.classList.add("plain");
    }
  }

  function cardUrl(id) {
    const u = new URL(location.href);
    u.search = "";
    u.hash = "";
    u.searchParams.set("id", id);
    return u.toString();
  }

  async function api(path, options = {}) {
    if (!API || API.includes("YOUR-API-ID")) {
      throw new Error("API 주소가 설정되지 않았습니다. config.js를 확인해 주세요.");
    }
    let res;
    try {
      res = await fetch(API + path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      });
    } catch {
      throw new Error("서버에 연결할 수 없습니다. 인터넷 연결이나 API 주소를 확인해 주세요.");
    }
    let data = {};
    try { data = await res.json(); } catch { /* 빈 응답 */ }
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  }

  // ---------- 카드 작성 ----------
  function initCreate() {
    $("create-view").hidden = false;
    const form = $("card-form");
    const err = $("form-error");
    const btn = $("submit-btn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.prompt.trim()) return showError("프롬프트를 입력해 주세요.", "prompt");
      if (!data.answer.trim()) return showError("AI 답변을 입력해 주세요.", "answer");

      btn.disabled = true;
      btn.textContent = "저장 중…";
      try {
        const { id } = await api("/cards", { method: "POST", body: JSON.stringify(data) });
        const url = cardUrl(id);
        $("share-url").value = url;
        $("open-card").href = url;
        form.hidden = true;
        $("created").hidden = false;
        if (await copyText(url)) toast("공유 링크를 복사했어요");
      } catch (ex) {
        showError(ex.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "카드 만들고 공유 링크 받기";
      }
    });

    function showError(msg, field) {
      err.textContent = msg;
      err.hidden = false;
      if (field) form.elements[field].focus();
    }

    $("copy-link").addEventListener("click", async () => {
      toast((await copyText($("share-url").value)) ? "링크를 복사했어요" : "복사에 실패했어요. 직접 선택해 복사해 주세요");
    });
    $("new-card").addEventListener("click", () => {
      form.reset();
      form.hidden = false;
      $("created").hidden = true;
      form.elements.prompt.focus();
    });
  }

  // ---------- 카드 보기 ----------
  function buildAiText(card, followup) {
    const lines = [
      "아래는 우리 팀원이 AI와 나눈 대화를 공유한 내용이야. 맥락을 먼저 이해한 뒤 내 질문에 답해 줘.",
      "",
      `## 제목: ${card.title}`,
      `- 사용한 AI: ${card.aiTool || "미기재"}${card.author ? ` / 공유한 사람: ${card.author}` : ""}`,
    ];
    if (card.memo) lines.push("", "## 공유한 사람의 메모 (왜 물어봤는지)", card.memo);
    lines.push(
      "",
      "## 팀원이 보낸 프롬프트",
      "<<<PROMPT",
      card.prompt,
      "PROMPT>>>",
      "",
      "## AI의 답변",
      "<<<ANSWER",
      card.answer,
      "ANSWER>>>",
      "",
      "## 내 질문",
      followup.trim() || "위 내용을 이해했으면 핵심을 3줄로 요약하고, 내가 이어서 무엇을 하면 좋을지 알려 줘."
    );
    return lines.join("\n");
  }

  async function initView(id) {
    $("card-view").hidden = false;
    let card;
    try {
      card = await api(`/cards/${encodeURIComponent(id)}`);
    } catch (ex) {
      $("card-loading").hidden = true;
      $("card-error").textContent = ex.message;
      $("card-error").hidden = false;
      return;
    }

    document.title = `${card.title} — 바톤`;
    $("c-title").textContent = card.title;
    $("c-ai").textContent = card.aiTool || "AI";
    $("c-author").textContent = card.author ? `${card.author} 님이 공유` : "";
    $("c-date").textContent = new Date(card.createdAt).toLocaleString("ko-KR");
    if (card.memo) {
      $("c-memo").textContent = card.memo;
      $("c-memo-box").hidden = false;
    }
    renderMarkdown($("c-prompt"), card.prompt);
    renderMarkdown($("c-answer"), card.answer);
    $("card-loading").hidden = true;
    $("card-layout").hidden = false;
    initChat(card);

    const msg = $("handoff-msg");
    const text = () => buildAiText(card, $("followup").value);

    $("copy-ai").addEventListener("click", async () => {
      const ok = await copyText(text());
      toast(ok ? "AI용으로 복사했어요. 내 AI 채팅창에 붙여넣으세요" : "복사에 실패했어요");
    });

    function openAi(name, base) {
      const t = text();
      if (t.length <= MAX_URL_PROMPT) {
        window.open(base + encodeURIComponent(t), "_blank", "noopener");
        msg.textContent = `${name}가 새 탭에서 열렸어요. 내용이 자동으로 들어가지 않았다면 "AI용으로 복사" 후 붙여넣어 주세요.`;
      } else {
        // 너무 길면 URL에 못 담으므로 복사 후 빈 채팅을 연다
        copyText(t);
        window.open(base.split("?")[0], "_blank", "noopener");
        msg.textContent = `내용이 길어서 클립보드에 복사해 두었어요. 열린 ${name} 채팅창에 붙여넣기(Ctrl+V / ⌘V) 해 주세요.`;
      }
      msg.hidden = false;
    }
    // 외부 AI의 URL 프롬프트 채우기는 공식 기능이 아니라 바뀔 수 있음 → 복사 안내를 함께 표시
    $("open-chatgpt").addEventListener("click", () => openAi("ChatGPT", "https://chatgpt.com/?q="));
    $("open-claude").addEventListener("click", () => openAi("Claude", "https://claude.ai/new?q="));
    $("copy-link2").addEventListener("click", async () => {
      toast((await copyText(cardUrl(card.id))) ? "카드 링크를 복사했어요" : "복사에 실패했어요");
    });
  }

  // ---------- 실시간 팀 채팅 ----------
  // 브라우저 저장소는 막혀 있을 수 있으므로 항상 try/catch
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  };
  function clientId() {
    try {
      let id = sessionStorage.getItem("lobster-client");
      if (!id) { id = Math.random().toString(36).slice(2, 12); sessionStorage.setItem("lobster-client", id); }
      return id;
    } catch {
      return (clientId._id ||= Math.random().toString(36).slice(2, 12));
    }
  }

  function initChat(card) {
    const WS = (window.LOBSTER_WS_URL || "").replace(/\/+$/, "");
    const me = clientId();
    const seen = new Set();
    const list = $("chat-list");
    const input = $("chat-input");
    let ws = null;
    let name = storage.get("lobster-name") || "";
    let retry = 0;
    let pingTimer = null;
    let closedByUser = false;

    function setStatus(kind, text) {
      const el = $("chat-status");
      el.className = "status " + kind;
      el.querySelector("span").textContent = text;
    }

    function fmtTime(iso) {
      return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    }

    function addMessage(m) {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      $("chat-empty").hidden = true;
      const li = document.createElement("li");
      li.className = "msg" + (m.clientId === me ? " mine" : "");
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = m.name;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.text; // 텍스트로만 넣어서 스크립트 삽입 방지
      const time = document.createElement("div");
      time.className = "time";
      time.textContent = fmtTime(m.createdAt);
      li.append(who, bubble, time);

      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.appendChild(li);
      if (nearBottom || m.clientId === me) list.scrollTop = list.scrollHeight;
    }

    async function loadHistory() {
      try {
        const { messages } = await api(`/cards/${encodeURIComponent(card.id)}/messages`);
        messages.forEach(addMessage);
        list.scrollTop = list.scrollHeight;
      } catch (ex) {
        console.warn("채팅 기록을 불러오지 못했어요", ex);
      }
    }

    function connect() {
      if (!WS || WS.includes("YOUR-WS-API-ID")) {
        setStatus("", "채팅 서버 주소 미설정");
        $("chat-online").textContent = "config.js의 LOBSTER_WS_URL을 설정해 주세요.";
        return;
      }
      setStatus("wait", retry ? "다시 연결 중…" : "연결 중…");
      ws = new WebSocket(`${WS}?cardId=${encodeURIComponent(card.id)}&name=${encodeURIComponent(name)}`);

      ws.onopen = () => {
        const wasRetry = retry > 0;
        retry = 0;
        setStatus("on", "실시간 연결됨");
        ws.send(JSON.stringify({ type: "hello" }));
        if (wasRetry) loadHistory(); // 끊긴 동안 놓친 메시지 채우기
        clearInterval(pingTimer);
        // API Gateway는 10분간 조용하면 연결을 끊으므로 5분마다 신호
        pingTimer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })), 5 * 60 * 1000);
      };
      ws.onmessage = (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        if (data.type === "message") addMessage(data.message);
        else if (data.type === "presence") {
          $("chat-online").textContent = `지금 ${data.online}명 접속 중 · ${data.names.join(", ")}`;
        } else if (data.type === "error") toast(data.error);
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (closedByUser) return;
        retry++;
        const wait = Math.min(30000, 1000 * 2 ** Math.min(retry, 5));
        setStatus("wait", `연결 끊김 · ${Math.round(wait / 1000)}초 후 재시도`);
        setTimeout(connect, wait);
      };
    }

    function join(newName) {
      name = newName.trim().slice(0, 20);
      storage.set("lobster-name", name);
      $("chat-join").hidden = true;
      $("chat-form").hidden = false;
      $("chat-rename").hidden = false;
      if (ws) { closedByUser = true; ws.close(); }
      closedByUser = false;
      retry = 0;
      connect();
      input.focus();
    }

    function sendMessage() {
      const text = input.value.trim();
      if (!text) return;
      if (!ws || ws.readyState !== 1) return toast("아직 연결되지 않았어요. 잠시 후 다시 보내 주세요");
      ws.send(JSON.stringify({ type: "message", text, clientId: me }));
      input.value = "";
    }

    $("chat-join").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("chat-name").value.trim();
      if (!v) return $("chat-name").focus();
      join(v);
    });
    $("chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
    input.addEventListener("keydown", (e) => {
      // 한글 입력 중(조합 중) Enter는 무시해야 마지막 글자가 두 번 가지 않음
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        sendMessage();
      }
    });
    $("chat-rename").addEventListener("click", () => {
      $("chat-name").value = name;
      $("chat-form").hidden = true;
      $("chat-rename").hidden = true;
      $("chat-join").hidden = false;
      $("chat-name").focus();
    });

    loadHistory();
    if (name) join(name);
    else $("chat-name").focus({ preventScroll: true });
  }

  // ---------- 시작 ----------
  const id = new URLSearchParams(location.search).get("id");
  if (id) initView(id);
  else initCreate();

  // 로컬 시험용으로 노출
  window.__lobster = { buildAiText };
})();
