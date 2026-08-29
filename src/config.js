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

export const config = {
  port: Number(process.env.PORT) || 5050,
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || null,
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
