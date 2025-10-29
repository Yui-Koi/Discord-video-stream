import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer, Utils } from "@dank074/discord-video-stream";
import config from "./config.json" with { type: "json" };
import http from "node:http";
import { URL } from "node:url";

// Control server URL (defaults to localhost:3000)
const CONTROL_SERVER_URL = process.env.CONTROL_SERVER_URL ?? "http://localhost:3000";

type StartGoLiveRequest = {
  guild_id: string;
  channel_id: string;
  user_id: string;
  session_id: string;
  stream_key: string;
  rtc_server_id: string;
  endpoint: string;
  token: string;
  video?: { width?: number; height?: number; fps?: number };
  encryptionPreference?: "AES256" | "XCHACHA20";
  ffmpeg: {
    input: string;
    options?: {
      width?: number;
      height?: number;
      frameRate?: number;
      bitrateVideo?: number;
      bitrateVideoMax?: number;
      bitrateAudio?: number;
      includeAudio?: boolean;
      encoder?: "software" | "nvenc";
      hardwareAcceleratedDecoding?: boolean;
      minimizeLatency?: boolean;
      customHeaders?: Record<string, string>;
      customFfmpegFlags?: string[];
    };
  };
};

type StopGoLiveRequest = { stream_key: string };

async function httpJson(method: "POST" | "GET", urlStr: string, body?: unknown): Promise<any> {
  const u = new URL(urlStr);
  const payload = body ? JSON.stringify(body) : undefined;
  const opts: http.RequestOptions = {
    method,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + (u.search || ""),
    headers: {
      "Content-Type": "application/json",
      "Content-Length": payload ? Buffer.byteLength(payload) : 0
    }
  };

  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        try {
          const obj = text ? JSON.parse(text) : { ok: true };
          resolve(obj);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

const streamer = new Streamer(new Client());

streamer.client.on("ready", () => {
  console.log(`--- ${streamer.client.user?.tag} is ready (control client) ---`);
});

let lastStreamKey: string | null = null;

// message event controller
streamer.client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!config.acceptedAuthors.includes(msg.author.id)) return;
  if (!msg.content) return;

  if (msg.content.startsWith("$control-go-live")) {
    const args = parseArgs(msg.content);
    if (!args) return;

    const channel = msg.author.voice?.channel;
    if (!channel || !msg.guildId) {
      console.log("User is not in a guild voice channel");
      return;
    }

    console.log(`Joining voice channel ${msg.guildId}/${channel.id}`);
    await streamer.joinVoice(msg.guildId!, channel.id);

    if (channel instanceof StageChannel) {
      await streamer.client.user?.voice?.setSuppressed(false);
    }

    // Ensure we have session_id
    const sessionId = await waitForSessionId(streamer, 5000);
    if (!sessionId) {
      console.log("Failed to obtain session_id");
      return;
    }

    // Signal stream on gateway to obtain stream_key and voice server info
    streamer.signalStream();

    const streamInfo = await waitForStreamInfo(streamer, 5000);
    if (!streamInfo) {
      console.log("Failed to obtain STREAM_CREATE/STREAM_SERVER_UPDATE");
      return;
    }

    lastStreamKey = streamInfo.stream_key;

    // Build StartGoLiveRequest payload
    const encryptionPreference = process.env.ENCRYPTION_PREFERENCE as "AES256" | "XCHACHA20" | undefined;
    const payload: StartGoLiveRequest = {
      guild_id: streamer.voiceConnection!.guildId!,
      channel_id: streamer.voiceConnection!.channelId,
      user_id: streamer.client.user!.id,
      session_id: sessionId,
      stream_key: streamInfo.stream_key,
      rtc_server_id: streamInfo.rtc_server_id,
      endpoint: streamInfo.endpoint,
      token: streamInfo.token,
      video: {
        width: config.streamOpts.width,
        height: config.streamOpts.height,
        fps: config.streamOpts.fps
      },
      encryptionPreference,
      ffmpeg: {
        input: args.url,
        options: {
          width: config.streamOpts.width,
          height: config.streamOpts.height,
          frameRate: config.streamOpts.fps,
          bitrateVideo: config.streamOpts.bitrateKbps,
          bitrateVideoMax: config.streamOpts.maxBitrateKbps,
          bitrateAudio: config.streamOpts.bitrateAudioKbps ?? 128,
          includeAudio: true,
          encoder: config.streamOpts.encoder === "nvenc" ? "nvenc" : "software",
          hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
          minimizeLatency: true,
          customHeaders: {},
          customFfmpegFlags: []
        }
      }
    };

    try {
      console.log("Calling control server /go-live/start");
      const res = await httpJson("POST", `${CONTROL_SERVER_URL}/go-live/start`, payload);
      console.log("Start response:", res);
    } catch (e) {
      console.error("Failed to start go-live via control server", e);
    }
  } else if (msg.content.startsWith("$control-stop")) {
    const stream_key = lastStreamKey ?? (
      streamer.voiceConnection
        ? Utils.generateStreamKey(
            streamer.voiceConnection.type,
            streamer.voiceConnection.guildId,
            streamer.voiceConnection.channelId,
            streamer.voiceConnection.botId
          )
        : ""
    );
    if (!stream_key) {
      console.log("No stream_key available");
      return;
    }
    try {
      console.log("Calling control server /go-live/stop");
      const res = await httpJson("POST", `${CONTROL_SERVER_URL}/go-live/stop`, { stream_key } as StopGoLiveRequest);
      console.log("Stop response:", res);
    } catch (e) {
      console.error("Failed to stop go-live via control server", e);
    }
  } else if (msg.content.startsWith("$control-status")) {
    const stream_key = lastStreamKey ?? (
      streamer.voiceConnection
        ? Utils.generateStreamKey(
            streamer.voiceConnection.type,
            streamer.voiceConnection.guildId,
            streamer.voiceConnection.channelId,
            streamer.voiceConnection.botId
          )
        : ""
    );
    if (!stream_key) {
      console.log("No stream_key available");
      return;
    }
    try {
      console.log("Calling control server /go-live/status");
      const res = await httpJson("GET", `${CONTROL_SERVER_URL}/go-live/status?stream_key=${encodeURIComponent(stream_key)}`);
      console.log("Status response:", res);
    } catch (e) {
      console.error("Failed to get status via control server", e);
    }
  }
});

// login
streamer.client.login(config.token);

function parseArgs(message: string): Args | undefined {
  const parts = message.split(" ");
  if (parts.length < 2) return;
  const url = parts[1];
  return { url };
}

type Args = { url: string };

async function waitForSessionId(streamer: Streamer, timeoutMs: number): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = streamer.voiceConnection?.session_id;
    if (s) return s;
    await sleep(50);
  }
  return null;
}

type StreamInfo = {
  stream_key: string;
  rtc_server_id: string;
  endpoint: string;
  token: string;
};

async function waitForStreamInfo(streamer: Streamer, timeoutMs: number): Promise<StreamInfo | null> {
  const { guildId, channelId } = streamer.voiceConnection!;
  const userId = streamer.client.user!.id;
  const start = Date.now();

  let stream_key: string | null = null;
  let rtc_server_id: string | null = null;
  let endpoint: string | null = null;
  let token: string | null = null;

  return new Promise<StreamInfo | null>((resolve) => {
    const onRaw = (packet: any) => {
      try {
        if (packet?.t === "STREAM_CREATE") {
          const { stream_key: sk, rtc_server_id: sid } = packet.d || {};
          const { guildId: g, channelId: c, userId: u } = Utils.parseStreamKey(sk);
          if (g === guildId && c === channelId && u === userId) {
            stream_key = sk;
            rtc_server_id = sid;
          }
        } else if (packet?.t === "STREAM_SERVER_UPDATE") {
          const { stream_key: sk, endpoint: ep, token: tk } = packet.d || {};
          const { guildId: g, channelId: c, userId: u } = Utils.parseStreamKey(sk);
          if (g === guildId && c === channelId && u === userId) {
            endpoint = ep;
            token = tk;
          }
        }
        if (stream_key && rtc_server_id && endpoint && token) {
          cleanup();
          resolve({ stream_key, rtc_server_id, endpoint, token });
        }
      } catch {
        // ignore
      }
    };
    const cleanup = () => {
      streamer.client.off("raw", onRaw);
    };
    streamer.client.on("raw", onRaw);

    const interval = setInterval(() => {
      if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        cleanup();
        resolve(null);
      }
    }, 100);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}