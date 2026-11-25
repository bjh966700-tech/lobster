# AWS 배포 가이드 (Sprint 1 + 실시간 채팅)

> 리전은 **서울 `ap-northeast-2`** 하나로 통일합니다.
> 시작 전에 Billing 콘솔에서 Free plan 여부, 남은 크레딧, 만료일을 확인하세요. 무료로 안 되면 **교수님께 알리고 유료로 바꾸지 마세요.**
> 비밀번호·액세스 키·인증 코드는 팀원과 공유하거나 Git/Notion에 적지 않습니다.

두 가지 방법이 있습니다. **A(SAM, 추천)** 는 명령어 한 번으로 전부 만들고, **B(콘솔)** 는 클릭으로 하나씩 만듭니다.

---

## A. SAM으로 백엔드 한 번에 배포 (추천)

필요: AWS CLI(로그인 완료), AWS SAM CLI, Node.js 24

```bash
sam build
sam deploy --guided
#   Stack Name: lobster
#   AWS Region: ap-northeast-2
#   Confirm changes before deploy: Y
#   Allow SAM CLI IAM role creation: Y
#   Save arguments to configuration file: Y   (samconfig.toml은 .gitignore 처리됨)
```

끝나면 Outputs에 두 주소가 나옵니다.
- `HttpApiUrl` → `frontend/config.js`의 `LOBSTER_API_URL`
- `WebSocketUrl` → `frontend/config.js`의 `LOBSTER_WS_URL`

코드를 고친 뒤 다시 배포: `sam build && sam deploy`

삭제(크레딧 아끼기): `sam delete --stack-name lobster`

그다음 **C. 화면 배포**로 가세요.

---

## B. 콘솔에서 클릭으로 배포

### B-1. DynamoDB 테이블 3개
| 테이블 이름 | 파티션 키 | 정렬 키 | 추가 설정 |
|---|---|---|---|
| `lobster-cards` | `id` (문자열) | 없음 | |
| `lobster-messages` | `cardId` (문자열) | `sk` (문자열) | |
| `lobster-connections` | `connectionId` (문자열) | 없음 | ① 인덱스 탭 → 글로벌 보조 인덱스 생성: 파티션 키 `cardId`(문자열), 인덱스 이름 **`byCard`**, 프로젝션 전체 ② 추가 설정 → TTL 켜기, 속성 이름 `ttl` |

용량 모드는 모두 **온디맨드**.

### B-2. Lambda 함수 1개
1. Lambda → 함수 생성 → 새로 작성 / 이름 `lobster-api` / 런타임 **Node.js 24.x**
2. 코드 탭의 `index.mjs`를 전부 지우고 `backend/index.mjs` 내용을 붙여넣기 → **Deploy** (핸들러는 기본값 `index.handler` 그대로)
3. 구성 → 환경 변수
   - `CARDS_TABLE` = `lobster-cards`
   - `MESSAGES_TABLE` = `lobster-messages`
   - `CONNECTIONS_TABLE` = `lobster-connections`
4. 구성 → 권한 → 실행 역할 클릭 → 권한 추가 → 인라인 정책 → JSON (계정 ID 12자리를 넣으세요):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:Query"],
      "Resource": [
        "arn:aws:dynamodb:ap-northeast-2:<계정ID>:table/lobster-cards",
        "arn:aws:dynamodb:ap-northeast-2:<계정ID>:table/lobster-messages",
        "arn:aws:dynamodb:ap-northeast-2:<계정ID>:table/lobster-connections",
        "arn:aws:dynamodb:ap-northeast-2:<계정ID>:table/lobster-connections/index/byCard"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "execute-api:ManageConnections",
      "Resource": "arn:aws:execute-api:ap-northeast-2:<계정ID>:*/*/POST/@connections/*"
    }
  ]
}
```

### B-3. HTTP API
1. API Gateway → **HTTP API** 구축 → 통합 추가: Lambda `lobster-api`
2. 경로
   - `POST /cards`
   - `GET /cards/{id}`
   - `GET /cards/{id}/messages`
   (모두 `lobster-api`로)
3. 스테이지 `$default` (자동 배포)
4. 왼쪽 **CORS**: Allow-Origin `*`, Allow-Methods `GET,POST,OPTIONS`, Allow-Headers `content-type` → 저장
5. 호출 URL 복사 → `LOBSTER_API_URL`

### B-4. WebSocket API
1. API Gateway → **WebSocket API** 구축
   - 이름 `lobster-chat`, 라우트 선택 표현식 `request.body.action`
2. 라우트 추가: **`$connect`, `$disconnect`, `$default`** (세 개 모두)
3. 통합: 세 라우트 모두 Lambda `lobster-api` (Lambda 프록시 통합) — 권한 추가 팝업은 **확인**
4. 스테이지 이름 **`production`**, 자동 배포
5. 스테이지 화면의 **WebSocket URL**(`wss://…/production`) 복사 → `LOBSTER_WS_URL`

### B-5. 백엔드 확인
```bash
# 카드 만들기
curl -X POST "<HTTP호출URL>/cards" -H "Content-Type: application/json" -d '{"prompt":"테스트","answer":"OK"}'
# → {"id":"..."}

# 채팅 (Node 필요: npx wscat)
npx wscat -c "<WS_URL>?cardId=<위 id>&name=test"
> {"type":"hello"}
> {"type":"message","text":"안녕"}
```

문제가 있으면 CloudWatch → 로그 그룹 `/aws/lambda/lobster-api`에서 오류를 확인하세요.

---

## C. 화면 배포 (Amplify Hosting)

1. `frontend/config.js`에 두 주소 입력 (끝에 `/` 없이)
```js
window.LOBSTER_API_URL = "https://abc123.execute-api.ap-northeast-2.amazonaws.com";
window.LOBSTER_WS_URL  = "wss://xyz789.execute-api.ap-northeast-2.amazonaws.com/production";
```
2. 배포 방법 중 하나
   - **Git 연결(추천)**: Amplify → 새 앱 → GitHub `bjh966700-tech/lobster`, 브랜치 `main` → 빌드 설정에서 빌드 명령 없음, 출력 디렉터리(baseDirectory) **`frontend`** → 이후 `main`에 push할 때마다 자동 배포
   - **수동**: `frontend` 폴더 *안의 파일들*을 zip → Amplify → Git 없이 배포 → 업로드
3. 배포 주소(`https://main.xxxx.amplifyapp.com`) 확인 후, 원하면 Lambda 환경 변수 `ALLOW_ORIGIN`에 그 주소를 넣어 CORS를 좁힙니다.

> `config.js`의 API 주소는 공개돼도 되는 값입니다(브라우저가 어차피 봅니다). 단, AWS 키 같은 비밀값은 절대 프론트에 넣지 마세요.

---

## D. 일요일 제출 전 최종 확인
- [ ] 배포 주소에서 카드 작성 → 링크 복사 → **다른 브라우저(시크릿 창)** 에서 열림
- [ ] 새로고침 후에도 카드·채팅 기록 유지
- [ ] 두 브라우저에서 같은 카드 채팅방 입장 → 메시지가 새로고침 없이 서로 보임, "지금 2명 접속 중"
- [ ] AI용 복사 → ChatGPT/Claude에 붙여넣으면 맥락이 정리돼 들어감
- [ ] 필수 입력 누락·없는 링크에서 안내 문구 표시
- [ ] CloudWatch 로그에 `card created` 확인, 오류 없음
- [ ] Billing에서 예상 비용 0 또는 크레딧 내 확인
