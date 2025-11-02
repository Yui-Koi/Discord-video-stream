import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer } from "@dank074/discord-video-stream";
import config from "./config.json" with { type: "json" };
import http from "node:http";
import { URL } from "node:url";

const CONTROL_SERVER_URL = process.env.CONTROL_SERVER_URL ?? config.serverUrl;

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
  console.log(`--- ${streamer.client.user?.tag} is ready (split client) ---`);
});

streamer.client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!config.acceptedAuthors.includes(msg.author.id)) return;
  if (!msg.content) return;

  if (msg.content.startsWith("$join")) {
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
    console.log("Joined. session_id:", streamer.voiceConnection?.session_id);
  } else if (msg.content.startsWith("$attach")) {
    const vc = streamer.voiceConnection;
    if (!vc?.session_id) {
      console.log("Join first to obtain session_id");
      return;
    }
    const payload = {
      guild_id: vc.guildId!,
      channel_id: vc.channelId,
      user_id: streamer.client.user!.id,
      session_id: vc.session_id
    };
    const res = await httpJson("POST", `${CONTROL_SERVER_URL}/v1/golive/attach`, payload);
    console.log("Attach:", res);
  } else if (msg.content.startsWith("$create-live")) {
    const parts = msg.content.split(" ");
    if (parts.length < 2) return;
    const url = parts[1];

    const vc = streamer.voiceConnection;
    if (!vc) {
      console.log("Join voice before creating");
      return;
    }
    const payload = {
      guild_id: vc.guildId!,
      channel_id: vc.channelId,
      video: {
        width: config.streamOpts.width,
        height: config.streamOpts.height,
        fps: config.streamOpts.fps
      },
      encryptionPreference: process.env.ENCRYPTION_PREFERENCE as ("AES256" | "XCHACHA20") | undefined,
      ffmpeg: {
        input: url,
        options: {
          width: config.streamOpts.width,
          height: config.streamOpts.height,
          frameRate: config.streamOpts.fps,
          bitrateVideo: config.streamOpts.bitrateKbps,
          bitrateVideoMax: config.streamOpts.maxBitrateKbps,
          bitrateAudio: 128,
          includeAudio: true,
          hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
          minimizeLatency: true
        }
      }
    };
    const res = await httpJson("POST", `${CONTROL_SERVER_URL}/v1/golive/create`, payload);
    console.log("Create:", res);
  } else if (msg.content.startsWith("$status-live")) {
    const vc = streamer.voiceConnection;
    if (!vc) {
      console.log("Join first");
      return;
    }
    const stream_key = `${vc.type}:${vc.guildId}:${vc.channelId}:${vc.botId}`;
    const res = await httpJson("GET", `${CONTROL_SERVER_URL}/v1/golive/status?stream_key=${encodeURIComponent(stream_key)}`);
    console.log("Status:", res);
  } else if (msg.content.startsWith("$stop-live")) {
    const vc = streamer.voiceConnection;
    if (!vc) {
      console.log("Join first");
      return;
    }
    const stream_key = `${vc.type}:${vc.guildId}:${vc.channelId}:${vc.botId}`;
    const res = await httpJson("POST", `${CONTROL_SERVER_URL}/v1/golive/stop`, { stream_key });
    console.log("Stop:", res);
  }
});

streamer.client.login(config.token);