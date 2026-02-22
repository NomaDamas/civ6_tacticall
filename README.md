# ojirapper (QR Auto-Login)

Goal: let a local Civ6 Computer Use Agent (HITL) generate a QR code so a phone can scan it and instantly connect for real-time command/state exchange.

## Components

- `server.js`: deployable web app + WebSocket relay (`/ws`)
- `bridge.js`: runs on the HITL PC and bridges local FastAPI WS (`ws://localhost:8000/ws`) to the relay
- `index.html`, `app.js`: mobile/desktop responsive web controller

## How It Works

1. `bridge.js` on the HITL PC authenticates to the relay as `host`
2. `bridge.js` requests `create_pair_qr` from the relay
3. Relay issues a one-time `pairUrl`
4. `bridge.js` prints a QR code in the terminal
5. Phone scans QR and opens `/?pair=...`
6. Web client performs `qr_pair_login` and stores a device token
7. Same phone/browser can auto-login afterward via `token_login`

## Control Messages

Controller -> HITL agent messages:

```json
{ "type": "command", "content": "natural language command" }
```

```json
{ "type": "control", "action": "start" }
```

```json
{ "type": "control", "action": "stop" }
```

The `Start Agent` / `Stop Agent` buttons send the `control` messages above.

HITL agent -> controller state messages:

```json
{ "type": "status", "data": { "state": "RUNNING", "step": 12, "task": "..." } }
```

or

```json
{ "type": "agent_state", "data": { "state": "RUNNING", "step": 12 } }
```

The web UI renders this JSON directly in `Agent State Snapshot`.

HITL agent -> controller live video frame message:

```json
{
  "type": "video_frame",
  "mime": "image/jpeg",
  "data": "<base64 JPEG bytes>",
  "width": 1280,
  "height": 720,
  "ts": 1730000000000
}
```

The web UI renders this in `Live View` in real time.

## Local Development

```bash
npm install
npm run dev
```

Web URL: `http://localhost:8787`

## Deployment

- Start command: `npm start`
- Use an HTTPS domain in production
- WebSocket endpoint: `wss://YOUR_DOMAIN/ws`

### Deploy on Render (Recommended)

1. Push this repository to GitHub
2. In Render, select `New +` -> `Blueprint` and connect the repo
3. Render reads `render.yaml` and creates the web service
4. Set `PUBLIC_BASE_URL=https://YOUR_DOMAIN`
5. Verify the Render URL, then attach your custom domain

## HITL PC Setup (One-Time)

```bash
cp host-config.example.json host-config.json
```

Example `host-config.json`:

- `relayUrl`: use `ws://127.0.0.1:8787/ws` for local test, `wss://YOUR_DOMAIN/ws` for deployed domain
- `controllerBaseUrl`: `auto` recommended (auto-detects current LAN IP for QR URL)
- `localApiBaseUrl`: local FastAPI base URL used by Discussion endpoint (e.g. `http://127.0.0.1:8765`)
- `localAgentUrl`: `ws://localhost:8000/ws`
- `discussionUserId`: user id for discussion session tracking (default `web_user`)
- `discussionMode`: one of `pre_game`, `in_game`, `post_turn` (default `in_game`)
- `discussionLanguage`: default language hint sent to FastAPI (`ko`, `en`, `ja`, `zh`; default `ko`)
- `roomId`: any room name you want
- `hostKey`: long secret string

Run:

```bash
npm run host
```

The pair QR is printed in the terminal.
To regenerate QR manually, in the `npm run host` terminal type `r` then press Enter.

## Discussion Toggle

- Open the `Discussion` toggle in the controller UI.
- It sends the chat text to FastAPI `POST /api/discuss` via bridge.
- Bridge payload:
  ```json
  { "user_id": "web_user", "message": "....", "mode": "in_game", "language": "ko" }
  ```
- The server-side engine uses latest strategy/context internally and returns `response`.
- You can copy the LLM suggestion into the main Command box.
- The controller has a `Discussion Language` setting. Selected value is sent in each discussion query.

## User Access

- Scan the QR from phone -> web opens -> auto-connect
- Use `Forget Device Login` in the web UI if re-pairing is needed
