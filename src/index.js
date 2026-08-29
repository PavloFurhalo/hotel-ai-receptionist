import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { RealtimeSession } from "@openai/agents/realtime";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import { config, getMediaStreamUrl } from "./config.js";
import { receptionistAgent, realtimeSessionConfig } from "./agent.js";
import {
  addError,
  addTranscriptEntry,
  announceCallStarted,
  attachCallSid,
  createCallLog,
  finishCall,
  getCallBySid,
  getPendingCall,
  getTranscriptText,
  listCalls,
  mergeCallMetadata,
  recordInterruption,
} from "./call-logger.js";
import { serializeReservationDraft } from "./reservation.js";

const fastify = Fastify({ logger: true });

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

/**
 * Extract spoken text from a Realtime history message item.
 * Supported by installed @openai/agents-realtime item schema:
 * - user: content[].type === "input_audio" → transcript
 * - assistant: content[].type === "output_audio" → transcript
 * - also supports input_text / output_text when present
 */
function extractMessageText(item) {
  if (!item || item.type !== "message" || !Array.isArray(item.content)) {
    return null;
  }

  const parts = [];
  for (const content of item.content) {
    if (!content || typeof content !== "object") continue;

    if (
      (content.type === "input_audio" || content.type === "output_audio") &&
      typeof content.transcript === "string" &&
      content.transcript.trim()
    ) {
      parts.push(content.transcript.trim());
    } else if (
      (content.type === "input_text" || content.type === "output_text") &&
      typeof content.text === "string" &&
      content.text.trim()
    ) {
      parts.push(content.text.trim());
    }
  }

  if (parts.length === 0) return null;
  return parts.join(" ").trim();
}

function syncTranscriptFromHistory(call, history) {
  if (!call || !Array.isArray(history)) return;

  for (const item of history) {
    if (!item || item.type !== "message") continue;
    if (item.status && item.status !== "completed") continue;

    const text = extractMessageText(item);
    if (!text) continue;

    const speaker = item.role === "user" ? "caller" : "assistant";
    if (item.role !== "user" && item.role !== "assistant") continue;

    addTranscriptEntry(call, speaker, text, { itemId: item.itemId });
  }
}

function extractTwilioStartMeta(event) {
  // TwilioRealtimeTransportLayer emits: { type: 'twilio_message', message: data }
  if (!event || event.type !== "twilio_message") return null;

  const message = event.message;
  if (!message || message.event !== "start" || !message.start) return null;

  const start = message.start;
  return {
    callSid: start.callSid || null,
    streamSid: start.streamSid || null,
    customParameters: start.customParameters || {},
  };
}

fastify.get("/health", async () => ({
  ok: true,
  service: "hotel-ai-receptionist",
  stage: "v1.2",
}));

fastify.get("/calls", async () => listCalls());

fastify.get("/calls/:callSid", async (request, reply) => {
  const call = await getCallBySid(request.params.callSid);
  if (!call) {
    return reply.status(404).send({ error: "Call not found" });
  }
  return call;
});

fastify.get("/calls/:callSid/transcript", async (request, reply) => {
  const transcript = await getTranscriptText(request.params.callSid);
  if (!transcript) {
    return reply.status(404).send("Transcript not found");
  }
  return reply.type("text/plain; charset=utf-8").send(transcript);
});

fastify.all("/incoming-call", async (request, reply) => {
  let streamUrl;

  try {
    streamUrl = getMediaStreamUrl(request);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send("PUBLIC_BASE_URL is not configured.");
  }

  const body = request.body || {};
  const callSid = body.CallSid || null;
  const from = body.From || null;
  const to = body.To || null;
  const direction = body.Direction || null;

  // Prefill metadata from the Twilio HTTP webhook.
  // The WebSocket may arrive separately; CallSid from stream "start" will link them.
  let call = callSid ? getPendingCall(callSid) : null;
  if (!call) {
    call = createCallLog({
      callSid,
      from,
      to,
      direction,
      metadata: {
        source: "incoming-call",
      },
    });
  } else {
    mergeCallMetadata(call, { from, to, direction });
  }

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  request.log.info(
    { streamUrl, callSid },
    "Incoming call — opening media stream"
  );
  return reply.type("text/xml").send(twimlResponse);
});

fastify.register(async (app) => {
  app.get("/media-stream", { websocket: true }, (connection, request) => {
    request.log.info("Media stream WebSocket connected");

    // Provisional log until Twilio stream "start" provides CallSid.
    let call = createCallLog({
      metadata: {
        source: "media-stream",
      },
      silent: true,
    });
    let finished = false;
    let session = null;
    const reservationDraftHolder = { draft: null };

    const safeFinish = async (status = "completed") => {
      if (finished) return;
      finished = true;
      try {
        call.reservationDraft = serializeReservationDraft(
          reservationDraftHolder.draft
        );
        await finishCall(call, { status });
      } catch (error) {
        request.log.error({ err: error }, "Failed to persist call log");
      }
    };

    const handleCallError = async (error, label = "Realtime error") => {
      const payload = error?.error ?? error;
      request.log.error({ err: payload }, label);
      addError(call, payload);

      try {
        session?.close?.();
      } catch {
        // ignore close errors
      }

      try {
        connection.close();
      } catch {
        // ignore
      }
    };

    try {
      const transport = new TwilioRealtimeTransportLayer({
        twilioWebSocket: connection,
      });

      session = new RealtimeSession(receptionistAgent, {
        transport,
        ...realtimeSessionConfig,
        context: {
          reservationDraftHolder,
          // Outbound test calls: guest number is typically in `To`.
          guestPhoneHint: null,
        },
      });

      // Prevent ERR_UNHANDLED_ERROR from crashing the process.
      session.on("error", (event) => {
        handleCallError(event, "RealtimeSession error");
      });

      transport.on("error", (event) => {
        handleCallError(event, "Transport error");
      });

      // Capture Twilio stream start → CallSid association.
      session.on("transport_event", (event) => {
        const startMeta = extractTwilioStartMeta(event);
        if (!startMeta) return;

        const existing = startMeta.callSid
          ? getPendingCall(startMeta.callSid)
          : null;

        if (existing && existing !== call) {
          // Prefer metadata captured at /incoming-call; keep this WS call object
          // only if we somehow already collected transcript here.
          if (call.transcript.length === 0 && call.errors.length === 0) {
            call = existing;
          } else {
            mergeCallMetadata(existing, {
              from: call.from,
              to: call.to,
              direction: call.direction,
              metadata: call.metadata,
            });
            for (const entry of call.transcript) {
              addTranscriptEntry(existing, entry.speaker, entry.text, {
                itemId: entry.itemId,
              });
            }
            for (const err of call.errors) {
              existing.errors.push(err);
            }
            call = existing;
          }
        }

        if (startMeta.callSid) {
          attachCallSid(call, startMeta.callSid);
        }

        mergeCallMetadata(call, {
          metadata: {
            streamSid: startMeta.streamSid,
            customParameters: startMeta.customParameters,
          },
        });

        // Seed phone hint for reservation draft (outbound: guest is To).
        const guestPhoneHint =
          call.direction === "outbound-api" || call.direction === "outbound"
            ? call.to
            : call.from;
        if (session?.context?.context) {
          session.context.context.guestPhoneHint = guestPhoneHint || null;
        }

        announceCallStarted(call);

        request.log.info(
          { callSid: call.callSid, streamSid: startMeta.streamSid },
          "Twilio media stream started"
        );
      });

      // Built-in SDK event: full conversation history with transcripts.
      session.on("history_updated", (history) => {
        syncTranscriptFromHistory(call, history);
      });

      // Useful for diagnosing barge-in / premature turn-taking after a call.
      session.on("audio_interrupted", () => {
        recordInterruption(call);
        request.log.info(
          { callSid: call.callSid, interruptions: call.metadata.interruptions },
          "Assistant audio interrupted"
        );
      });

      connection.on("error", (error) => {
        handleCallError(error, "WebSocket error");
      });

      connection.on("close", () => {
        request.log.info({ callSid: call.callSid }, "Media stream WebSocket closed");
        safeFinish(call.errors.length > 0 ? "error" : "completed");
        try {
          session?.close?.();
        } catch {
          // ignore
        }
      });

      session.connect({ apiKey: config.openaiApiKey }).then(
        () => {
          request.log.info(
            { callSid: call.callSid },
            "Connected to OpenAI Realtime API"
          );
        },
        (error) => {
          handleCallError(error, "Realtime connection error");
        }
      );
    } catch (error) {
      handleCallError(error, "Media stream setup error");
      safeFinish("error");
    }
  });
});

const start = async () => {
  try {
    await fastify.listen({ port: config.port, host: "0.0.0.0" });
    console.log(`Server listening on http://0.0.0.0:${config.port}`);
    if (!config.publicBaseUrl) {
      console.warn(
        "PUBLIC_BASE_URL is not set. Set it to your ngrok HTTPS URL before testing with Twilio."
      );
    }
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
};

start();

process.on("SIGINT", async () => {
  await fastify.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await fastify.close();
  process.exit(0);
});
