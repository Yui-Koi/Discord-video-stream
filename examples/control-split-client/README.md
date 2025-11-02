# Control split client — test example

Purpose:
- Join the guild voice channel you are in.
- Call the control split server to attach and start Go Live streaming.

Use this to validate the split model with two independent processes.

## Prerequisites

- Node >= 21
- Your Discord self token
- The control server from `examples/control-split-server` running

## Run

1) Install deps:
```
npm install
```

2) Build:
```
npm run build
```

3) Start the client:
```
CONTROL_SERVER_URL="http://localhost:4000" npm run start
```

## Commands

Send messages as the accepted author while in a guild voice channel:

- `$join` — client joins your current channel and captures session_id
- `$attach` — posts your guild/channel/user/session_id to the control server
- `$create-live <video-url>` — requests the control server to create Go Live and start streaming
- `$status-live` — fetches stream status
- `$stop-live` — stops streaming

Configure `src/config.json` before running.