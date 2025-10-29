# Basic example

This example shows how to:
- Stream a video via camera or Go Live using the library directly
- Drive the Control Server (src/controlServer.ts) from a separate “controller client” to start/stop Go Live

## 1) Direct usage (existing)

See `src/index.ts`. It logs in with your self token, joins the voice channel you’re in, and accepts commands:
- `$play-live <url>` — Go Live (guild voice)
- `$play-cam <url>` — camera stream on the voice connection
- `$stop-stream` — aborts current stream
- `$disconnect` — leaves voice

Configure `src/config.json`:
```json
{
  "token": "SELF TOKEN HERE",
  "acceptedAuthors": ["USER_ID_HERE"],
  "streamOpts": {
    "width": 1280,
    "height": 720,
    "fps": 30,
    "bitrateKbps": 1000,
    "maxBitrateKbps": 2500,
    "hardware_acceleration": false,
    "videoCodec": "H264"
  }
}
```

Build and run:
```
npm run build
npm run start
```

## 2) Control Server + Controller Client

This demonstrates a split architecture:
- Control Server owns Go Live media connection (WS/UDP, ffmpeg, RTP). It logs into Discord using `DISCORD_TOKEN`.
- Controller Client owns the gateway presence, joins voice, signals STREAM_CREATE/STREAM_SERVER_UPDATE, and calls the Control Server HTTP API to start Go Live.

### Start the Control Server (root project)

From the repository root (not inside examples/basic):
1) Build the library:
```
npm run build
```

2) Start the control server with your self token:
```
DISCORD_TOKEN="YOUR_TOKEN" npm run start:control
```
It will listen on `http://localhost:3000` by default.
Optional flags:
- `CONTROL_LOG_HTTP=1` to log HTTP bodies with sensitive fields redacted
- `CONTROL_LOG_WS=1` to log Voice WS message metadata

### Start the Controller Client (this example)

From `examples/basic`:
1) Build:
```
npm run build
```

2) Start:
```
# Optional: point to another host/port
# CONTROL_SERVER_URL="http://localhost:3000" ENCRYPTION_PREFERENCE="XCHACHA20"
npm run start:control-client
```

It logs in using `src/config.json.token` and waits for your commands.

Controller commands (send as plain messages from an accepted author while you are in a guild voice channel):
- `$control-go-live <direct-video-url>`
  - Joins your current voice channel
  - Signals STREAM_CREATE/STREAM_SET_PAUSED
  - Captures VOICE_STATE_UPDATE (session_id) and STREAM_* data
  - Calls Control Server `/go-live/start` with ffmpeg options from `streamOpts`
- `$control-stop`
  - Calls Control Server `/go-live/stop` with the current `stream_key`
- `$control-status`
  - Calls Control Server `/go-live/status` and prints the state

Notes:
- For Stage Channels, the controller unsuppresses yourself automatically.
- The Control Server selects AES-256-GCM or XChaCha20 based on `ENCRYPTION_PREFERENCE` (optional). Without it, AES-256 is preferred if supported; set `ENCRYPTION_PREFERENCE="XCHACHA20"` for better performance on CPUs without AES-NI.

### Flow summary

- Controller Client (this example) owns gateway presence, voice join, and signaling.
- Control Server (root) owns Go Live WS/UDP and media pipeline.
- The two processes use the same account and cooperate safely in guild voice:
  - One voice presence connection (controller client)
  - One Go Live media connection (control server)

### Caution

Selfbots violate Discord’s Terms of Service and can result in permanent bans. Use at your own risk.
