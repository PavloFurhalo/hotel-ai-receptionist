import dotenv from "dotenv";

dotenv.config();

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

const VAD_EAGERNESS = process.env.REALTIME_VAD_EAGERNESS?.trim() || "low";
const VALID_EAGERNESS = new Set(["low", "medium", "high", "auto"]);

/** Built-in Realtime voices; marin/cedar are highest quality. */
const VALID_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);
const VOICE_FROM_ENV = process.env.REALTIME_VOICE?.trim() || "marin";

export const config = {
  port: Number(process.env.PORT) || 5050,
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || null,
  /**
   * Dev/test only: allow ?hotelId= override on /incoming-call.
   * Never enable in production — phone mapping is the only production router.
   */
  allowHotelOverride:
    process.env.ALLOW_HOTEL_OVERRIDE === "true" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test",
};

export const voiceConfig = {
  /** semantic_vad eagerness: low = fewer false end-of-turn, medium = faster first response */
  vadEagerness: VALID_EAGERNESS.has(VAD_EAGERNESS) ? VAD_EAGERNESS : "low",
  /** Post-processing TTS speed (0.25–1.5). */
  outputSpeed: clampNumber(process.env.REALTIME_OUTPUT_SPEED, 0.25, 1.5, 1.0),
  /** Realtime TTS voice */
  voice: VALID_VOICES.has(VOICE_FROM_ENV) ? VOICE_FROM_ENV : "marin",
  latencyLog: process.env.VOICE_LATENCY_LOG !== "false",
  debugState: process.env.VOICE_DEBUG_STATE === "true",
};

export function getMediaStreamUrl(request) {
  if (config.publicBaseUrl) {
    const host = new URL(config.publicBaseUrl).host;
    return `wss://${host}/media-stream`;
  }

  const host =
    request.headers["x-forwarded-host"] ||
    request.headers.host;

  if (!host) {
    throw new Error(
      "Cannot determine public host for Media Stream. Set PUBLIC_BASE_URL in .env (e.g. your ngrok HTTPS URL)."
    );
  }

  return `wss://${host}/media-stream`;
}
