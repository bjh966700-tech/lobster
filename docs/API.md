# 🏃 바톤 API 명세서

> 버전: v0.3 (Sprint 1 배포본) · 최종 수정: 2026-11-25 · 배포 리전: 시드니 `ap-southeast-2`
> 구현: `backend/index.mjs` (Lambda 1개가 HTTP와 WebSocket을 모두 처리)
> 자동 시험: `npm test` (`tests/smoke.test.mjs`)

## 0. 개요

| 구분 | AWS 서비스 | 기본 주소 | 프론트 설정 |
|---|---|---|---|
| HTTP API | API Gateway **HTTP API** (`lobster-http`) | `https://d53kr4pr9d.execute-api.ap-southeast-2.amazonaws.com` | `window.LOBSTER_API_URL` |
| WebSocket API | API Gateway **WebSocket API** (`lobster-chat`) | `wss://tau0dq4z3l.execute-api.ap-southeast-2.amazonaws.com/production` | `window.LOBSTER_WS_URL` |
| 로컬 시험 | `local/server.mjs` | HTTP `http://localhost:3000/api` · WS `ws://localhost:3000/ws` | 자동 주입 |

화면(프론트) 주소: `https://main.d2byt69swcwe5a.amplifyapp.com` · 공유 링크 = 화면 주소 + `/?id={카드ID}`

### 한눈에 보기
| 종류 | 메서드 / 이벤트 | 경로 | 설명 | 성공 |
|---|---|---|---|---|
| HTTP | `POST` | `/cards` | 카드 만들기 | `201 { id }` |
| HTTP | `GET` | `/cards/{id}` | 카드 보기 | `200 Card` |
| HTTP | `GET` | `/cards/{id}/messages` | 채팅 기록(최근 100개) | `200 { messages }` |
| WS | 연결 | `?cardId=&name=` | 카드 채팅방 입장 | 연결 |
| WS | 보내기 | `{"type":"hello"}` | 접속자 목록 요청 | `presence` 수신 |
| WS | 보내기 | `{"type":"message","text","clientId"}` | 메시지 보내기 | `message` 수신(전원) |
| WS | 보내기 | `{"type":"ping"}` | 연결 유지 | 응답 없음 |

공통 규칙
- 요청·응답 본문은 **JSON (UTF-8)**.
- 인증 없음 (Sprint 1). 카드 ID를 아는 사람은 누구나 카드와 채팅을 볼 수 있음 → **카드 ID가 사실상 비밀 링크** 역할.
- 오류 응답 형식은 항상 `{ "error": "사용자에게 보여 줄 한국어 문장" }`.
- CORS: `Access-Control-Allow-Origin: *` (환경 변수 `ALLOW_ORIGIN`으로 좁힐 수 있음), 메서드 `GET, POST, OPTIONS`, 헤더 `Content-Type`.
- ID 형식: 영문 대소문자+숫자 6~20자 (`^[A-Za-z0-9]{6,20}$`). 생성 시 10자, 헷갈리는 문자(0/O/1/l/I) 제외.

---

## 1. 데이터 모델

### Card (테이블 `CARDS_TABLE`, 파티션 키 `id`)
| 필드 | 타입 | 필수 | 제한 | 설명 |
|---|---|---|---|---|
| `id` | string | 서버 생성 | 10자 | 카드 ID (공유 링크 `?id=` 값) |
| `title` | string | 선택 | ≤ 120자 | 비우면 프롬프트 첫 줄 앞 60자로 자동 생성 |
| `prompt` | string | **필수** | ≤ 30,000자 | 사용자가 AI에게 보낸 프롬프트 (마크다운 가능) |
| `answer` | string | **필수** | ≤ 60,000자 | AI 답변 (마크다운 가능) |
| `memo` | string | 선택 | ≤ 2,000자 | 왜 물어봤는지 / 팀원에게 할 말 |
| `aiTool` | string | 선택 | ≤ 40자 | 사용한 AI (ChatGPT, Claude, Gemini, Kiro, Copilot, 기타) |
| `author` | string | 선택 | ≤ 40자 | 작성자 이름 |
| `createdAt` | string | 서버 생성 | ISO 8601 | 생성 시각 (UTC) |

모든 문자열은 앞뒤 공백을 제거한 뒤 검사합니다. DynamoDB 항목 최대 크기(400KB) 안에 들어가도록 제한을 두었습니다.

### Message (테이블 `MESSAGES_TABLE`, 파티션 키 `cardId` + 정렬 키 `sk`)
| 필드 | 타입 | 설명 |
|---|---|---|
| `cardId` | string | 어느 카드의 채팅인지 |
| `sk` | string | `"{13자리 밀리초 타임스탬프}#{4자 난수}"` — 시간순 정렬·중복 방지 |
| `id` | string | 메시지 ID (8자). 프론트에서 중복 표시 방지에 사용 |
| `name` | string | 보낸 사람 이름 (≤ 20자, 비면 `"익명"`) — 접속 시 정한 이름 |
| `clientId` | string | 보낸 브라우저 탭 ID (≤ 40자). 프론트가 "내 메시지"를 구분하는 용도. **보안용 아님** |
| `text` | string | 메시지 본문 (1 ~ 2,000자) |
| `createdAt` | string | ISO 8601 |

### Connection (테이블 `CONNECTIONS_TABLE`, 파티션 키 `connectionId`, GSI `byCard`(파티션 키 `cardId`))
| 필드 | 타입 | 설명 |
|---|---|---|
| `connectionId` | string | API Gateway가 준 WebSocket 연결 ID |
| `cardId` | string | 입장한 카드 |
| `name` | string | 접속자 이름 |
| `ttl` | number | 유닉스 초. 접속 후 2시간 뒤 DynamoDB TTL로 자동 삭제 (비정상 종료 대비) |

---

## 2. HTTP API

### 2.1 `POST /cards` — 카드 만들기

요청
```json
{
  "title": "DynamoDB 카드 저장 구조",
  "prompt": "카드 공유 서비스에서 DynamoDB 키를 어떻게 잡아?",
  "answer": "## 추천\n- `id`를 파티션 키로 ...",
  "memo": "우리 저장 구조 정하려고 물어봄!",
  "aiTool": "Claude",
  "author": "재엽"
}
```

응답
| 상태 | 본문 | 상황 |
|---|---|---|
| `201` | `{ "id": "yiauqUGbJP" }` | 성공 |
| `400` | `{ "error": "JSON 형식이 올바르지 않습니다." }` | 본문이 JSON이 아님 |
| `400` | `{ "error": "프롬프트을 입력해 주세요." }` / `"AI 답변을 입력해 주세요."` | 필수 값 누락 (※ "프롬프트을"은 조사 오류 — 알려진 문제, 화면은 자체 검사로 "프롬프트를"을 먼저 보여 줌) |
| `400` | `{ "error": "메모은(는) 2,000자 이하로 입력해 주세요." }` | 길이 초과 |
| `400` | `{ "error": "작성자 값이 올바르지 않습니다." }` | 문자열이 아닌 값 |
| `500` | `{ "error": "서버 오류가 발생했습니다. ..." }` | 서버 오류 (CloudWatch 로그 확인) |

공유 링크 = 프론트 주소 + `?id={id}` (예: `https://main.d2byt69swcwe5a.amplifyapp.com/?id=yiauqUGbJP`)

### 2.2 `GET /cards/{id}` — 카드 보기

| 상태 | 본문 |
|---|---|
| `200` | Card 객체 전체 |
| `404` | `{ "error": "카드를 찾을 수 없습니다. 링크를 다시 확인해 주세요." }` — ID 형식은 맞지만 카드가 없음 |
| `404` | `{ "error": "지원하지 않는 요청입니다." }` — ID 형식이 틀림 (예: `/cards/nope`). 화면은 이 문구를 그대로 보여 줌 |

### 2.3 `GET /cards/{id}/messages` — 채팅 기록

최근 **100개**를 오래된 것 → 최신 순으로 돌려줍니다. 화면 첫 진입과 재연결 직후에 호출합니다.

| 상태 | 본문 |
|---|---|
| `200` | `{ "messages": [Message, ...] }` |
| `404` | `{ "error": "카드를 찾을 수 없습니다." }` |
| `404` | `{ "error": "지원하지 않는 요청입니다." }` — ID 형식이 틀림 |

### 2.4 `OPTIONS *`
CORS 사전 요청. 배포본에서는 API Gateway의 CORS 설정이 직접 `204`로 응답합니다 (Lambda까지 오지 않음).

### 2.5 등록되지 않은 경로
API Gateway에 라우트가 없는 경로(예: `GET /hello`)는 Lambda까지 오지 않고 API Gateway가 `404 { "message": "Not Found" }`로 응답합니다. 형식이 `error`가 아니라 `message`인 점에 주의.

### 2.6 호출 예 (curl)
```bash
API=https://d53kr4pr9d.execute-api.ap-southeast-2.amazonaws.com

# 카드 만들기 → {"id":"..."}
curl -X POST "$API/cards" -H "Content-Type: application/json" \
  -d '{"prompt":"테스트 질문","answer":"테스트 답변","aiTool":"Claude","author":"재엽"}'

# 카드 보기
curl "$API/cards/{id}"

# 채팅 기록
curl "$API/cards/{id}/messages"
```

---

## 3. WebSocket API (실시간 팀 채팅)

API Gateway WebSocket의 라우트 3개를 같은 Lambda로 연결합니다. 라우트 선택식은 `$request.body.action`이지만 **`action` 필드를 쓰지 않으므로 모든 메시지가 `$default`로 들어갑니다.** 메시지 종류는 `type` 필드로 구분합니다.

### 3.1 연결 (`$connect`)
```
wss://tau0dq4z3l.execute-api.ap-southeast-2.amazonaws.com/production?cardId={카드ID}&name={URL 인코딩한 이름}
```
| 결과 | 상황 |
|---|---|
| 연결 성공 (200) | 카드가 있으면 Connection 저장 |
| 거부 400 | `cardId` 형식 오류 |
| 거부 404 | 카드 없음 |

`$connect` 안에서는 아직 메시지를 보낼 수 없으므로, **연결이 열리면 클라이언트가 곧바로 `{"type":"hello"}`를 보내** 접속자 목록을 갱신합니다.

### 3.2 클라이언트 → 서버 (`$default`)
| `type` | 본문 예 | 서버 동작 |
|---|---|---|
| `hello` | `{"type":"hello"}` | 같은 카드 접속자 전원에게 `presence` 전송 |
| `message` | `{"type":"message","text":"이 설계 괜찮아?","clientId":"k3j9x0a1b2"}` | Message 저장 → 같은 카드 접속자 **전원(보낸 사람 포함)** 에게 `message` 전송 |
| `ping` | `{"type":"ping"}` | 아무것도 안 함. API Gateway 유휴 종료(10분) 방지용, 프론트가 5분마다 보냄 |

규칙: `text`는 앞뒤 공백 제거 후 1~2,000자. 빈 메시지는 무시, 2,000자 초과는 보낸 사람에게만 `error` 전송.

### 3.3 서버 → 클라이언트
```json
{ "type": "message", "message": { "cardId": "...", "sk": "...", "id": "a1B2c3D4", "name": "가윤", "clientId": "k3j9x0a1b2", "text": "좋아!", "createdAt": "2026-11-25T09:28:13.000Z" } }
{ "type": "presence", "online": 2, "names": ["재엽", "가윤"] }
{ "type": "error", "error": "메시지는 2,000자 이하로 보내 주세요." }
```
- `presence`는 누군가 `hello`를 보내거나 연결을 끊을 때(`$disconnect`) 전송됩니다. `online`은 연결 수(같은 사람이 탭 두 개면 2), `names`는 중복 제거한 이름 목록입니다.
- 전송 중 `410 Gone`이 나는 연결은 끊긴 것으로 보고 Connection을 삭제합니다.

### 3.4 연결 종료 (`$disconnect`)
Connection 삭제 → 남은 접속자에게 `presence` 전송.

### 3.5 호출 예 (wscat)
```bash
npx wscat -c "wss://tau0dq4z3l.execute-api.ap-southeast-2.amazonaws.com/production?cardId={카드ID}&name=test"
> {"type":"hello"}
< {"type":"presence","online":1,"names":["test"]}
> {"type":"message","text":"안녕","clientId":"cli1"}
< {"type":"message","message":{...}}
```

### 3.6 프론트 재연결 규칙 (`frontend/app.js`)
- 끊기면 1s → 2s → 4s … 최대 30s 간격으로 다시 연결.
- 다시 연결되면 `GET /cards/{id}/messages`로 놓친 메시지를 채우고, 메시지 `id`로 중복 표시를 막습니다.
- 한글 입력 조합 중 Enter(`isComposing`/`keyCode 229`)는 전송하지 않습니다.

---

## 4. 환경 변수 (Lambda)

| 이름 | 예 | 설명 |
|---|---|---|
| `CARDS_TABLE` | `lobster-cards` | 카드 테이블 (예전 이름 `TABLE_NAME`도 인식) |
| `MESSAGES_TABLE` | `lobster-messages` | 메시지 테이블 |
| `CONNECTIONS_TABLE` | `lobster-connections` | 접속 테이블 (GSI `byCard` 필수) |
| `ALLOW_ORIGIN` | `https://main.d2byt69swcwe5a.amplifyapp.com` | (선택) CORS 허용 주소. 기본 `*` (현재 배포본은 미설정) |

Lambda 실행 역할에 필요한 권한: 세 테이블의 `PutItem/GetItem/DeleteItem/Query`(GSI 포함), `execute-api:ManageConnections`. (현재 배포본은 자동 생성된 `PowerUserRole`을 쓰고 있어 이보다 넓음 → Sprint 2에 최소 권한으로 교체 예정)

---

## 5. 변경 이력
| 버전 | 날짜 | 내용 |
|---|---|---|
| v0.1 | 2026-11-25 | 카드 생성·조회 |
| v0.2 | 2026-11-25 | 실시간 팀 채팅(WebSocket), 채팅 기록 API, Lambda 단일 파일(`index.mjs`)로 통합, 런타임 Node.js 24.x |
| v0.3 | 2026-11-25 | 시드니 배포 주소 반영, 한눈에 보기 표·호출 예 추가, 배포본에서 실제 확인한 응답(ID 형식 오류, 미등록 경로, CORS) 명시 |

## 6. 다음 버전에서 바뀔 수 있는 부분 (예정)
- 로그인 도입 시 `Authorization` 헤더와 작성자·권한 필드 추가
- 팀 공간(`/teams/{teamId}/cards`) 추가
- `POST /cards/{id}/ask` — Amazon Bedrock으로 카드 맥락을 넣어 AI에게 이어서 질문 (응답을 채팅에 `type: "ai"` 메시지로 공유)
- MCP 서버: `list_cards`, `get_card`, `search_cards`, `post_message` 도구 제공
