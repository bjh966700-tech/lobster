# 🦞 랍스터 — AI 대화 공유 카드 (Sprint 1)

AI에게 쓴 **프롬프트 + AI 답변 + 메모**를 카드 한 장으로 올리고, 링크 하나로 팀원에게 공유합니다.
받은 사람은 맥락을 보고 **"AI용으로 복사"** 또는 **"ChatGPT/Claude로 열기"** 버튼으로 바로 이어서 물어볼 수 있습니다.

## 구조

```
브라우저 ──▶ Amplify Hosting (frontend/)
   │
   └─ fetch ──▶ API Gateway (HTTP API) ──▶ Lambda (backend/handler.mjs) ──▶ DynamoDB
```

| 폴더/파일 | 내용 |
|---|---|
| `frontend/` | 화면 (HTML/CSS/JS, 빌드 없음). `config.js`에 API 주소 입력 |
| `backend/handler.mjs` | Lambda 함수. `POST /cards` 생성, `GET /cards/{id}` 조회 |
| `template.yaml` | (선택) AWS SAM으로 백엔드를 한 번에 배포하는 설정 |
| `local/server.mjs` | AWS 없이 내 컴퓨터에서 시험하는 서버 |

## 1. 내 컴퓨터에서 먼저 시험하기

Node.js 20 이상이 필요합니다.

```bash
node local/server.mjs
# 브라우저에서 http://localhost:3000
```

저장은 메모리에만 되므로 서버를 끄면 카드가 사라집니다. (화면과 API 동작 확인용)

## 2. AWS에 배포하기 (콘솔에서 클릭으로)

> 리전은 **서울(ap-northeast-2)** 하나로 통일하세요. 시작 전에 Billing 콘솔에서 Free plan, 남은 크레딧, 만료일을 확인하세요.
> 비밀번호·액세스 키는 팀원과 공유하지 말고, 팀원은 각자 IAM 사용자로 들어오거나 화면 공유로 함께 작업하세요.

### ① DynamoDB 테이블
1. DynamoDB → **테이블 생성**
2. 테이블 이름: `lobster-cards` / 파티션 키: `id` (문자열)
3. 나머지는 기본값(온디맨드) → 생성

### ② Lambda 함수
1. Lambda → **함수 생성** → 새로 작성
2. 이름: `lobster-cards-api` / 런타임: **Node.js 20.x**
3. 생성 후 코드 탭의 `index.mjs` 내용을 **전부 지우고** `backend/handler.mjs` 내용을 붙여넣기 → **Deploy**
4. 구성 → 환경 변수 → `TABLE_NAME` = `lobster-cards`
5. 구성 → 권한 → 실행 역할 이름 클릭 → IAM에서 **권한 추가 → 인라인 정책** → JSON:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["dynamodb:PutItem", "dynamodb:GetItem"],
       "Resource": "arn:aws:dynamodb:ap-northeast-2:<내 계정 ID>:table/lobster-cards"
     }]
   }
   ```

### ③ API Gateway (HTTP API)
1. API Gateway → **HTTP API 구축**
2. 통합 추가 → Lambda → `lobster-cards-api`
3. 경로 구성:
   - `POST` `/cards` → lobster-cards-api
   - `GET` `/cards/{id}` → lobster-cards-api
4. 스테이지: `$default` (자동 배포)
5. 생성 후 왼쪽 **CORS** 메뉴:
   - Access-Control-Allow-Origin: `*` (배포 후 Amplify 주소로 좁히면 더 좋음)
   - Access-Control-Allow-Methods: `GET, POST, OPTIONS`
   - Access-Control-Allow-Headers: `content-type`
6. **호출 URL**을 복사해 둡니다. 예: `https://abc123.execute-api.ap-northeast-2.amazonaws.com`

시험: 터미널에서
```bash
curl -X POST <호출URL>/cards -H "Content-Type: application/json" -d '{"prompt":"테스트","answer":"OK"}'
# {"id":"..."} 가 나오면 성공
```

### ④ Amplify Hosting (화면)
1. `frontend/config.js`의 `LOBSTER_API_URL`을 ③의 호출 URL로 바꾸기 (끝에 `/` 없이)
2. `frontend` 폴더 **안의 파일들**을 zip으로 압축 (zip을 열었을 때 바로 `index.html`이 보여야 함)
3. Amplify → **새 앱 생성** → **Git 없이 배포(Deploy without Git)** → zip 끌어다 놓기
4. 배포된 주소(`https://…amplifyapp.com`)로 접속해 카드 만들기 → 다른 브라우저에서 링크 열기 확인

> GitHub에 올렸다면 Amplify에서 저장소를 연결해 push할 때마다 자동 배포되게 할 수도 있습니다.
> 이때 빌드 설정의 출력 폴더(baseDirectory)를 `frontend`로 지정하세요.

### (선택) SAM으로 백엔드 한 번에 배포
AWS CLI와 SAM CLI가 설치·로그인되어 있다면 ①~③ 대신:
```bash
sam deploy --guided   # 스택 이름: lobster, 리전: ap-northeast-2
```
출력되는 `ApiUrl`을 `frontend/config.js`에 넣고 ④를 진행하세요.

## 3. 일요일 제출 전 확인 (완료 기준)
- [ ] 배포 주소에서 카드 작성 → 링크 복사 → 다른 브라우저에서 확인 → AI용 복사까지 끝까지 된다
- [ ] 새로고침해도 카드가 남아 있다 (DynamoDB에 저장됨)
- [ ] 프롬프트/답변을 비우고 저장하면 안내 문구가 나온다
- [ ] 없는 링크(`?id=abcdefghij`)로 들어가면 "카드를 찾을 수 없습니다"가 나온다
- [ ] 두 사람이 합친 버전을 각자 시험했다
- [ ] CloudWatch 로그에서 `card created` 기록을 확인했다

## 알려진 한계 (Sprint 1)
- 로그인이 없어서 **링크를 아는 사람은 누구나 카드를 볼 수 있습니다.** 비밀번호·개인정보를 카드에 넣지 마세요.
- "ChatGPT/Claude로 열기"는 각 서비스가 공식 지원하는 기능이 아니어서 내용이 자동으로 안 들어갈 수 있습니다. 그럴 땐 "AI용으로 복사" 후 붙여넣으면 됩니다. 내용이 6,000자를 넘으면 자동으로 복사 후 빈 채팅을 엽니다.
- 카드 수정·삭제는 아직 없습니다.

## 다음 Sprint 후보
팀 공간, Amazon Bedrock으로 플랫폼 안에서 "이어서 질문하기", 스레드, MCP 서버 연동, 로그인.
