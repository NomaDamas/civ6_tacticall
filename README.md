# Civ VI Remote Command Center (QR Auto-Login)

목표: 로컬 Civ6 Computer Use Agent(HITL)가 QR을 발급하고, 휴대폰이 스캔하면 즉시 연결/송수신.

## 구성

- `server.js`: 배포용 웹 + WebSocket 릴레이 (`/ws`)
- `bridge.js`: HITL PC에서 로컬 FastAPI WS(`ws://localhost:8000/ws`)와 릴레이를 연결
- `index.html`, `app.js`: 모바일/데스크톱 반응형 웹 컨트롤러

## 동작 방식

1. HITL PC의 `bridge.js`가 릴레이에 host로 인증
2. `bridge.js`가 서버에 `create_pair_qr` 요청
3. 서버가 1회용 `pairUrl` 발급
4. `bridge.js`가 터미널에 QR 출력
5. 휴대폰이 QR 스캔해 `/?pair=...`로 접속
6. 웹이 자동으로 `qr_pair_login` 수행, 디바이스 토큰 저장
7. 이후 같은 폰/브라우저는 자동 로그인 (`token_login`)

## 컨트롤 메시지

컨트롤러 -> HITL 에이전트로 전달되는 메시지:

```json
{ "type": "command", "content": "자연어 명령" }
```

```json
{ "type": "control", "action": "start" }
```

```json
{ "type": "control", "action": "stop" }
```

`Start Agent`/`Stop Agent` 버튼은 위 `control` 메시지를 전송합니다.

HITL 에이전트 -> 컨트롤러 상태 전송:

```json
{ "type": "status", "data": { "state": "RUNNING", "step": 12, "task": "..." } }
```

또는

```json
{ "type": "agent_state", "data": { "state": "RUNNING", "step": 12 } }
```

웹은 `Agent State Snapshot` 패널에 JSON을 그대로 표시합니다.

## 로컬 개발

```bash
npm install
npm run dev
```

웹: `http://localhost:8787`

## 배포

- Start command: `npm start`
- HTTPS 도메인 필수
- WebSocket endpoint: `wss://YOUR_DOMAIN/ws`

### Render로 배포(추천)

1. 이 저장소를 GitHub에 push
2. Render에서 `New +` -> `Blueprint` 선택 후 repo 연결
3. `render.yaml`을 읽어 자동으로 웹서비스 생성
4. 환경변수 `PUBLIC_BASE_URL=https://YOUR_DOMAIN` 입력
5. Render 기본 URL 확인 후 Custom Domain에서 도메인 연결

## HITL PC 설정 (최초 1회)

```bash
cp host-config.example.json host-config.json
```

`host-config.json` 예:

- `relayUrl`: `wss://YOUR_DOMAIN/ws`
- `controllerBaseUrl`: `https://YOUR_DOMAIN`
- `localAgentUrl`: `ws://localhost:8000/ws`
- `roomId`: 원하는 방 이름
- `hostKey`: 긴 비밀 문자열

실행:

```bash
npm run host
```

실행하면 터미널에 Pair QR이 자동 출력됩니다.

## 사용자 접속

- 휴대폰으로 QR 스캔 -> 웹 열림 -> 자동 연결
- 재로그인 필요 시 웹에서 `Forget Device Login`
