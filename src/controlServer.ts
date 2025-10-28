import http from "node:http";
import { URL } from "node:url";
import { StreamConnection } from "./client/voice/StreamConnection.js";
import { Streamer } from "./client/Streamer.js";
import { VideoStream } from "./media/VideoStream.js";
import { AudioStream } from "./media/AudioStream.js";
import { demux } from "./media/LibavDemuxer.js";
import { AVCodecID } from "./media/LibavCodecId.js";
import { SupportedVideoCodec, isFiniteNonZero } from "./utils.js";
import { prepareStream } from "./media/newApi.js";
import { Encoders } from "./media/encoders/index.js";
import Log from "debug-level";

const controlLog = new Log("control");
const httpLog = new Log("control:http");
const wsLog = new Log("control:ws");
const udpLog = new Log("control:udp");
const ffLog = new Log("control:ffmpeg");
const demuxLog = new Log("control:demux");
const packetizerLog = new Log("control:packetizer");
const streamLog = new Log("control:stream");
const protoLog = new Log("control:proto");

// Feature flags via env
const LOG_HTTP_BODIES = (process.env.CONTROL_LOG_HTTP ?? "").toLowerCase() === "1";
const LOG_WS_MESSAGES = (process.env.CONTROL_LOG_WS ?? "").toLowerCase() === "1";

function redact(obj: unknown): unknown {
    if (!obj || typeof obj !== "object") return obj;
    try {
        const clone = JSON.parse(JSON.stringify(obj));
        const visit = (o: any) => {
            if (!o || typeof o !== "object") return;
            for (const k of Object.keys(o)) {
                if (typeof o[k] === "object") visit(o[k]);
                if (["token", "secret_key", "authorization"].includes(k.toLowerCase())) {
                    o[k] = "<redacted>";
                }
            }
        };
        visit(clone);
        return clone;
    } catch {
        return obj;
    }
}

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
    abort?: AbortController;
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
        forceChacha20Encryption: false,
        rtcpSenderReportEnabled: true,
    });

    await streamer.client.login(token);
    controlLog.info({ user: streamer.client.user?.id }, "Logged in to Discord");

    const sessions = new Map<string, GoLiveSession>();

    async function startGoLive(payload: StartGoLiveRequest) {
        const {
            guild_id, channel_id, user_id,
            session_id, stream_key, rtc_server_id,
            endpoint, token: voiceToken,
            video: vidAttrs, encryptionPreference, ffmpeg
        } = payload;

        if (sessions.has(stream_key)) {
            throw new Error(`Stream ${stream_key} already running`);
        }
        if (!streamer.client.user || streamer.client.user.id !== user_id) {
            throw new Error("Logged-in user does not match provided user_id");
        }

        // Create StreamConnection using provided session/tokens (no gateway signaling here)
        const conn = new StreamConnection(
            streamer,
            guild_id,
            user_id,
            channel_id,
            () => { /* resolved later */ }
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
            abort: undefined,
            stop: async () => {
                try { conn.setSpeaking(false); } catch {}
                try { conn.setVideoAttributes(false); } catch {}
                try { session.abort?.abort(); } catch {}
                try { conn.udp?.stop(); } catch {}
                try { conn.stop(); } catch {}
                for (const f of session.cleanupFns) {
                    try { f(); } catch {}
                }
                controlLog.info({ stream_key }, "Stopped Go Live session");
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

        controlLog.info({
            guild_id, channel_id, user_id, rtc_server_id, endpoint,
            video: vidAttrs, encryptionPreference
        }, "Starting Go Live handoff");

        // Attach WS lifecycle logging (if available)
        const attachWsLogs = () => {
            const ws = conn.ws;
            if (!ws) return;
            ws.on("open", () => wsLog.info("Voice WS open"));
            ws.on("error", (err) => wsLog.error(err, "Voice WS error"));
            ws.on("close", (code) => wsLog.warn({ code }, "Voice WS close"));
            if (LOG_WS_MESSAGES) {
                ws.on("message", (data, isBinary) => {
                    if (isBinary) return;
                    try {
                        const msg = JSON.parse(String(data));
                        wsLog.debug({ op: msg?.op, keys: Object.keys(msg || {}) }, "Voice WS message");
                    } catch {
                        wsLog.debug("Voice WS message (non-JSON)");
                    }
                });
            }
        };
        // try initial attach, and re-attach after small delay in case ws not ready
        attachWsLogs();
        setTimeout(attachWsLogs, 500);

        // Wait loop helper
        const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                if (pred()) return true;
                await new Promise(r => setTimeout(r, 50));
            }
            controlLog.warn({ label }, "WaitFor timed out");
            return false;
        };

        // Once the SELECT_PROTOCOL_ACK is received, configure and start media
        conn.once("select_protocol_ack", async () => {
            try {
                protoLog.info("Received SELECT_PROTOCOL_ACK");

                // Wait until UDP is ready
                const udpReady = await waitFor(() => conn.udp.ready, 5000, "udp.ready");
                udpLog.info({ ready: udpReady, ip: conn.udp.ip, port: conn.udp.port }, "UDP readiness");

                // speaking: 2 (go-live)
                conn.setSpeaking(true);
                controlLog.info("Set speaking=2 (go-live)");

                // Use provided video attrs if any; else will infer after demux
                const cfgWidth = isFiniteNonZero(vidAttrs?.width) ? Math.round(vidAttrs!.width!) : undefined;
                const cfgHeight = isFiniteNonZero(vidAttrs?.height) ? Math.round(vidAttrs!.height!) : undefined;
                const cfgFps = isFiniteNonZero(vidAttrs?.fps) ? Math.round(vidAttrs!.fps!) : undefined;

                // Start ffmpeg producer
                const abort = new AbortController();
                session.abort = abort;
                const encoderGetter = (ffmpeg.options?.encoder === "nvenc") ? Encoders.nvenc() : Encoders.software();
                const prep = prepareStream(ffmpeg.input, { ...(ffmpeg.options ?? {}), encoder: encoderGetter }, abort.signal);
                ffLog.info({ input: ffmpeg.input, options: ffmpeg.options, encoder: ffmpeg.options?.encoder }, "Started ffmpeg prepareStream");

                // Demux producer output
                const { video, audio } = await demux(prep.output, { format: "nut" });
                if (!video) throw new Error("No video stream");
                demuxLog.info({
                    width: video.width, height: video.height,
                    framerate_num: video.framerate_num, framerate_den: video.framerate_den,
                    codec: video.codec
                }, "Demuxed video stream");

                const inferredWidth = video.width ?? 1280;
                const inferredHeight = video.height ?? 720;
                const inferredFps = Math.round((video.framerate_num / video.framerate_den) || 30);

                // Set video attributes AFTER ACK and UDP ready
                conn.setVideoAttributes(true, {
                    width: cfgWidth ?? inferredWidth,
                    height: cfgHeight ?? inferredHeight,
                    fps: cfgFps ?? inferredFps
                });
                controlLog.info({
                    width: cfgWidth ?? inferredWidth,
                    height: cfgHeight ?? inferredHeight,
                    fps: cfgFps ?? inferredFps
                }, "Sent VIDEO attributes");

                // Select packetizer by codec
                const codecMap: Record<number, SupportedVideoCodec> = {
                    [AVCodecID.AV_CODEC_ID_H264]: "H264",
                    [AVCodecID.AV_CODEC_ID_H265]: "H265",
                    [AVCodecID.AV_CODEC_ID_VP8]: "VP8",
                    [AVCodecID.AV_CODEC_ID_VP9]: "VP9",
                    [AVCodecID.AV_CODEC_ID_AV1]: "AV1"
                };
                const codec = codecMap[video.codec] ?? "H264";
                packetizerLog.info({ codec }, "Selected packetizer codec");

                const udp = conn.udp;
                udp.setPacketizer(codec);

                // Pipe data to RTP
                const vStream = new VideoStream(udp);
                session.cleanupFns.push(() => vStream.destroy());
                video.stream.pipe(vStream);
                streamLog.info("Piping video stream to RTP");

                if (audio) {
                    const aStream = new AudioStream(udp);
                    session.cleanupFns.push(() => aStream.destroy());
                    audio.stream.pipe(aStream);
                    vStream.syncStream = aStream;
                    streamLog.info("Piping audio stream to RTP and enabling A/V sync");
                }

                session.state = "running";
                controlLog.info("Session state -> running");

                // Observe ffmpeg completion/errors
                prep.promise.then(() => {
                    ffLog.info("ffmpeg pipeline ended");
                    if (session.state === "running") {
                        session.state = "stopped";
                        controlLog.info("Session state -> stopped");
                    }
                }).catch((e) => {
                    ffLog.error(e, "ffmpeg pipeline error");
                    session.state = "error";
                    session.lastError = e instanceof Error ? e.message : String(e);
                });
            } catch (e) {
                controlLog.error(e, "Error in select_protocol_ack handler");
                session.state = "error";
                session.lastError = e instanceof Error ? e.message : String(e);
            }
        });
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
            httpLog.info({ method: req.method, path: url.pathname }, "HTTP request");
            if (req.method === "POST" && url.pathname === "/go-live/start") {
                const body = await parseJsonBody(req) as StartGoLiveRequest;
                if (LOG_HTTP_BODIES) {
                    httpLog.info({ body: redact(body) }, "Start request body");
                }
                await startGoLive(body);
                jsonResponse(res, 200, { ok: true });
                return;
            }
            if (req.method === "POST" && url.pathname === "/go-live/stop") {
                const body = await parseJsonBody(req) as StopGoLiveRequest;
                if (LOG_HTTP_BODIES) {
                    httpLog.info({ body: redact(body) }, "Stop request body");
                }
                const session = sessions.get(body.stream_key);
                if (!session) {
                    jsonResponse(res, 404, { ok: false, error: "not found" });
                    return;
                }
                session.state = "stopping";
                controlLog.info({ stream_key: body.stream_key }, "Stopping Go Live session");
                await session.stop();
                sessions.delete(body.stream_key);
                jsonResponse(res, 200, { ok: true });
                return;
            }
            if (req.method === "GET" && url.pathname === "/go-live/status") {
                const stream_key = url.searchParams.get("stream_key") ?? "";
                httpLog.debug({ stream_key }, "Status request");
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
            controlLog.error(e, "HTTP handler error");
            jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    const port = Number(process.env.PORT ?? 3000);
    server.listen(port, () => {
        controlLog.info({ port }, `Control server listening on http://localhost:${port}`);
    });

    return { server, streamer };
}

// Auto-start if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
    startControlServer().catch((e) => {
        controlLog.error(e, "Failed to start control server");
        process.exit(1);
    });
}`) {
    const controlLog = new Log("control");
    startControlServer().catch((e) => {
        controlLog.error(e, "Failed to start control server");
        process.exit(1);
    });
}