import http from "node:http";
import { URL } from "node:url";
import { StreamConnection } from "./client/voice/StreamConnection.js";
import { VoiceOpCodes } from "./client/voice/VoiceOpCodes.js";
import { Streamer } from "./client/Streamer.js";
import { VideoStream } from "./media/VideoStream.js";
import { AudioStream } from "./media/AudioStream.js";
import { demux } from "./media/LibavDemuxer.js";
import { AVCodecID } from "./media/LibavCodecId.js";
import { SupportedVideoCodec, isFiniteNonZero } from "./utils.js";

type StartGoLiveRequest = {
    guild_id: string;
    channel_id: string;
    user_id: string;
    session_id: string;
    stream_key: string;
    rtc_server_id: string;
    endpoint: string;
    token: string;
    video?: {
        width?: number;
        height?: number;
        fps?: number;
    };
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

type StopGoLiveRequest = {
    stream_key: string;
};

type StatusResponse = {
    state: "starting" | "running" | "stopping" | "stopped" | "error";
    lastError?: string;
    metrics?: {
        packetsSent?: number;
        lastHeartbeat?: number;
        encryptionMode?: "AES256" | "XCHACHA20";
    };
};

type GoLiveSession = {
    streamKey: string;
    conn: StreamConnection;
    state: StatusResponse["state"];
    lastError?: string;
    cleanupFns: (() => void)[];
    stop: () => Promise<void>;
};

function jsonResponse(res: http.ServerResponse, code: number, body: unknown) {
    const data = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(data);
}

async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf-8");
                const obj = raw ? JSON.parse(raw) : {};
                resolve(obj);
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", (e) => reject(e));
    });
}

/**
 * Minimal control server around Streamer that accepts Go Live handoff
 * from an external controller (e.g., Python) and performs streaming.
 */
export async function startControlServer() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error("DISCORD_TOKEN env var not set");
    }

    const streamer = new Streamer(new (await import("discord.js-selfbot-v13")).Client(), {
        // Allow external preference; default follows library behavior
        forceChacha20Encryption: false,
        rtcpSenderReportEnabled: true,
    });

    await streamer.client.login(token);

    const sessions = new Map<string, GoLiveSession>();

    async function startGoLive(payload: StartGoLiveRequest) {
        const {
            guild_id, channel_id, user_id,
            session_id, stream_key, rtc_server_id,
            endpoint, token: voiceToken,
            video, encryptionPreference, ffmpeg
        } = payload;

        if (sessions.has(stream_key)) {
            throw new Error(`Stream ${stream_key} already running`);
        }
        if (!streamer.client.user || streamer.client.user.id !== user_id) {
            throw new Error("Logged-in user does not match provided user_id");
        }

        // Instantiate a StreamConnection without signaling STREAM_CREATE;
        // set serverId, streamKey, session/tokens from handoff payload.
        const conn = new StreamConnection(
            streamer,
            guild_id,
            user_id,
            channel_id,
            () => { /* ready callback handled below */ }
        );
        conn.serverId = rtc_server_id;
        conn.streamKey = stream_key;
        conn.setSession(session_id);
        conn.setTokens(endpoint, voiceToken);

        const session: GoLiveSession = {
            streamKey: stream_key,
            conn,
            state: "starting",
            cleanupFns: [],
            stop: async () => {
                try {
                    // Signal stream deletion and disable media
                    conn.sendOpcode(VoiceOpCodes.STREAM_DELETE, { stream_key });
                    conn.setSpeaking(false);
                    conn.setVideoAttributes(false);
                } catch {}
                try { conn.udp?.stop(); } catch {}
                try { conn.stop(); } catch {}
                // Run cleanups
                for (const f of session.cleanupFns) {
                    try { f(); } catch {}
                }
                session.state = "stopped";
            }
        };
        sessions.set(stream_key, session);

        // Encryption preference tweak
        if (encryptionPreference === "XCHACHA20") {
            streamer.opts.forceChacha20Encryption = true;
        } else if (encryptionPreference === "AES256") {
            streamer.opts.forceChacha20Encryption = false;
        }

        // Once the SELECT_PROTOCOL_ACK is received, configure attributes
        conn.once("select_protocol_ack", async () => {
            try {
                // Mark speaking as Go Live (speaking: 2)
                conn.setSpeaking(true);

                // Set video attributes
                const w = isFiniteNonZero(video?.width) ? Math.round(video!.width!) : 1280;
                const h = isFiniteNonZero(video?.height) ? Math.round(video!.height!) : 720;
                const fps = isFiniteNonZero(video?.fps) ? Math.round(video!.fps!) : 30;

                conn.setVideoAttributes(true, { width: w, height: h, fps });

                // Prepare ffmpeg pipeline
                const { default: ffmpegLib } = await import("fluent-ffmpeg");
                // We reuse the demux + VideoStream/AudioStream path instead of playStream() to avoid gateway signaling
                const input = ffmpeg.input;
                const inputSpec = ffmpeg.input; // Not used directly; we build command via newApi-like logic

                // Build a similar pipeline: run ffmpeg producing NUT, then demux and pipe
                const { PassThrough } = await import("node:stream");
                const output = new PassThrough();

                const command = ffmpegLib(ffmpeg.input ? ffmpeg.input : ffmpeg.input)
                    .addOption("-loglevel", "info")
                    .input(ffmpeg.input ? ffmpeg.input : ffmpeg.input);

                // Configure input
                const merged = {
                    width: ffmpeg.options?.width,
                    height: ffmpeg.options?.height,
                    frameRate: ffmpeg.options?.frameRate,
                    bitrateVideo: ffmpeg.options?.bitrateVideo ?? 5000,
                    bitrateVideoMax: ffmpeg.options?.bitrateVideoMax ?? 7000,
                    bitrateAudio: ffmpeg.options?.bitrateAudio ?? 128,
                    includeAudio: ffmpeg.options?.includeAudio ?? true,
                    hardwareAcceleratedDecoding: ffmpeg.options?.hardwareAcceleratedDecoding ?? false,
                    minimizeLatency: ffmpeg.options?.minimizeLatency ?? false,
                    customHeaders: ffmpeg.options?.customHeaders ?? {
                        "User-Agent": "Mozilla/5.0",
                        "Connection": "keep-alive",
                    },
                    customFfmpegFlags: ffmpeg.options?.customFfmpegFlags ?? [],
                    encoder: ffmpeg.options?.encoder ?? "software",
                };

                if (merged.hardwareAcceleratedDecoding) {
                    command.inputOption("-hwaccel", "auto");
                }
                if (merged.minimizeLatency) {
                    command.addOptions(["-fflags nobuffer", "-analyzeduration 0"]);
                }
                if (ffmpeg.input.startsWith("http")) {
                    command.inputOption("-headers",
                        Object.entries(merged.customHeaders).map(([k, v]) => `${k}: ${v}`).join("\r\n")
                    );
                }

                // Output setup
                command.output(output).outputFormat("nut");

                // Video setup
                command.addOutputOption("-map 0:v");
                if (merged.width || merged.height) {
                    const wOpt = isFiniteNonZero(merged.width) ? merged.width : -2;
                    const hOpt = isFiniteNonZero(merged.height) ? merged.height : -2;
                    command.videoFilter(`scale=${wOpt}:${hOpt}`);
                }
                if (merged.frameRate) {
                    command.fpsOutput(merged.frameRate);
                }
                command.addOutputOption([
                    "-b:v", `${merged.bitrateVideo}k`,
                    "-maxrate:v", `${merged.bitrateVideoMax}k`,
                    "-bf", "0",
                    "-pix_fmt", "yuv420p",
                    "-force_key_frames", "expr:gte(t,n_forced*1)"
                ]);

                // Encoder selection minimal: stick to libx264 for H264 and libvpx for VP8 if needed
                // For simplicity, use H264 software encoder
                command.videoCodec("libx264").outputOptions(["-preset", "veryfast"]);

                // Audio setup
                if (merged.includeAudio) {
                    command.addOutputOption("-map 0:a?");
                    command.audioChannels(2);
                    command.addOutputOption("-lfe_mix_level 1");
                    command.audioFrequency(48000);
                    command.audioCodec("libopus");
                    command.audioBitrate(`${merged.bitrateAudio}k`);
                }

                if (merged.customFfmpegFlags.length > 0) {
                    command.addOptions(merged.customFfmpegFlags);
                }

                const onError = (e: unknown) => {
                    session.state = "error";
                    session.lastError = e instanceof Error ? e.message : String(e);
                };

                command.on("error", onError);
                command.on("end", () => {
                    // finished naturally
                    if (session.state !== "stopping" && session.state !== "stopped") {
                        session.state = "stopped";
                    }
                });

                command.run();

                // Demux and pipe
                const { video, audio } = await demux(output, { format: "nut" });
                if (!video) throw new Error("No video stream");

                // Map codec to packetizer
                const codecMap: Record<number, SupportedVideoCodec> = {
                    [AVCodecID.AV_CODEC_ID_H264]: "H264",
                    [AVCodecID.AV_CODEC_ID_H265]: "H265",
                    [AVCodecID.AV_CODEC_ID_VP8]: "VP8",
                    [AVCodecID.AV_CODEC_ID_VP9]: "VP9",
                    [AVCodecID.AV_CODEC_ID_AV1]: "AV1"
                };
                const codec = codecMap[video.codec] ?? "H264";

                // Prepare UDP and packetizers
                const udp = conn.udp;
                udp.setPacketizer(codec);

                const vStream = new VideoStream(udp);
                session.cleanupFns.push(() => vStream.destroy());

                video.stream.pipe(vStream);

                if (audio) {
                    const aStream = new AudioStream(udp);
                    session.cleanupFns.push(() => aStream.destroy());
                    audio.stream.pipe(aStream);
                    vStream.syncStream = aStream;
                }

                session.state = "running";
            } catch (e) {
                session.state = "error";
                session.lastError = e instanceof Error ? e.message : String(e);
            }
        });
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
            if (req.method === "POST" && url.pathname === "/go-live/start") {
                const body = await parseJsonBody(req) as StartGoLiveRequest;
                await startGoLive(body);
                jsonResponse(res, 200, { ok: true });
                return;
            }
            if (req.method === "POST" && url.pathname === "/go-live/stop") {
                const body = await parseJsonBody(req) as StopGoLiveRequest;
                const session = sessions.get(body.stream_key);
                if (!session) {
                    jsonResponse(res, 404, { ok: false, error: "not found" });
                    return;
                }
                session.state = "stopping";
                await session.stop();
                sessions.delete(body.stream_key);
                jsonResponse(res, 200, { ok: true });
                return;
            }
            if (req.method === "GET" && url.pathname === "/go-live/status") {
                const stream_key = url.searchParams.get("stream_key") ?? "";
                const session = sessions.get(stream_key);
                if (!session) {
                    jsonResponse(res, 404, { ok: false, error: "not found" });
                    return;
                }
                const out: StatusResponse = {
                    state: session.state,
                    lastError: session.lastError
                };
                jsonResponse(res, 200, out);
                return;
            }
            jsonResponse(res, 404, { ok: false, error: "unknown route" });
        } catch (e) {
            jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    const port = Number(process.env.PORT ?? 3000);
    server.listen(port, () => {
        console.log(`Control server listening on http://localhost:${port}`);
    });

    return { server, streamer };
}

// Auto-start if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
    startControlServer().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}