import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { RealtimeSession } from "@openai/agents/realtime";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import { config, getMediaStreamUrl, voiceConfig } from "./config.js";
import {
  createReceptionistAgent,
  realtimeSessionConfig,
} from "./agent.js";
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
import {
  attachVoicePipeline,
  isRecoverableVoiceError,
  sendVoiceFallback,
} from "./voice-pipeline.js";
import {
  getHotelById,
  listHotels,
  listPhoneNumbers,
  resolveHotelForCall,
} from "./hotels/registry.js";

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

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function genericUnavailableTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="uk-UA">Перепрошую, цей номер зараз не налаштований для прийому дзвінків. Будь ласка, спробуйте пізніше.</Say>
  <Hangup/>
</Response>`;
}

fastify.get("/health", async () => ({
  ok: true,
  service: "hotel-ai-receptionist",
  stage: "v1.3-multi-hotel",
  hotels: listHotels().map((h) => h.id),
  voice: {
    vadEagerness: voiceConfig.vadEagerness,
    outputSpeed: voiceConfig.outputSpeed,
  },
  allowHotelOverride: config.allowHotelOverride,
}));

fastify.get("/hotels", async () =>
  listHotels({ includeInactive: true }).map((hotel) => ({
    id: hotel.id,
    status: hotel.status,
    name: hotel.hotel?.name,
    nameUk: hotel.hotel?.nameUk,
    timezone: hotel.timezone,
    defaultLanguage: hotel.defaultLanguage,
  }))
);

fastify.get("/hotels/:id", async (request, reply) => {
  const hotel = getHotelById(request.params.id, { allowInactive: true });
  if (!hotel) {
    return reply.status(404).send({ error: "Hotel not found" });
  }
  return hotel;
});

fastify.get("/phone-numbers", async () => listPhoneNumbers());

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
  const query = request.query || {};
  const callSid = body.CallSid || null;
  const from = body.From || null;
  const to = body.To || null;
  const direction = body.Direction || null;

  // Dev/test only: ?hotelId=carpathian-resort (disabled unless allowHotelOverride).
  const hotelIdOverride =
    typeof query.hotelId === "string" && query.hotelId.trim()
      ? query.hotelId.trim()
      : null;

  const resolution = resolveHotelForCall({
    to,
    from,
    direction,
    hotelIdOverride,
    allowOverride: config.allowHotelOverride,
  });

  if (!resolution.ok) {
    request.log.warn(
      {
        code: resolution.code,
        to,
        from,
        direction,
        hotelIdOverride,
        allowHotelOverride: config.allowHotelOverride,
      },
      "Hotel resolution failed — generic unavailable response"
    );

    // Never fall back to another hotel.
    return reply.type("text/xml").send(genericUnavailableTwiml());
  }

  const hotel = resolution.hotel;

  // Prefill metadata from the Twilio HTTP webhook.
  // The WebSocket may arrive separately; CallSid from stream "start" will link them.
  let call = callSid ? getPendingCall(callSid) : null;
  if (!call) {
    call = createCallLog({
      callSid,
      from,
      to,
      direction,
      hotelId: hotel.id,
      hotelPhone: resolution.phoneNumber,
      metadata: {
        source: "incoming-call",
        hotelConfig: hotel,
        hotelResolution: {
          viaOverride: Boolean(resolution.viaOverride),
          phoneNumber: resolution.phoneNumber,
        },
      },
    });
  } else {
    mergeCallMetadata(call, {
      from,
      to,
      direction,
      hotelId: hotel.id,
      hotelPhone: resolution.phoneNumber,
      metadata: {
        hotelConfig: hotel,
        hotelResolution: {
          viaOverride: Boolean(resolution.viaOverride),
          phoneNumber: resolution.phoneNumber,
        },
      },
    });
  }

  // Twilio Media Streams strips query strings from Stream URLs.
  // Put hotelId in the path so it survives to the WebSocket upgrade.
  const streamUrlWithHotel = `${streamUrl.replace(/\/$/, "")}/${encodeURIComponent(hotel.id)}`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrlWithHotel)}">
      <Parameter name="hotelId" value="${escapeXml(hotel.id)}" />
    </Stream>
  </Connect>
</Response>`;

  request.log.info(
    {
      streamUrl: streamUrlWithHotel,
      callSid,
      hotelId: hotel.id,
      hotelName: hotel.hotel?.name,
      viaOverride: Boolean(resolution.viaOverride),
    },
    "Incoming call — opening media stream"
  );
  return reply.type("text/xml").send(twimlResponse);
});

fastify.register(async (app) => {
  // hotelId is in the path because Twilio drops Stream URL query params.
  app.get("/media-stream/:hotelId", { websocket: true }, (connection, request) => {
    const hotelIdFromPath =
      typeof request.params?.hotelId === "string"
        ? decodeURIComponent(request.params.hotelId).trim()
        : null;

    request.log.info(
      { hotelId: hotelIdFromPath },
      "Media stream WebSocket connected"
    );

    // Hotel must already be resolved at /incoming-call and passed via stream URL path.
    // Never invent or fall back to a different hotel here.
    const hotel = hotelIdFromPath
      ? getHotelById(hotelIdFromPath, { allowInactive: false })
      : null;

    if (!hotel) {
      request.log.error(
        { hotelIdFromPath },
        "Media stream missing/invalid hotelId — closing"
      );
      try {
        connection.close();
      } catch {
        // ignore
      }
      return;
    }

    // Provisional log until Twilio stream "start" provides CallSid.
    let call = createCallLog({
      hotelId: hotel.id,
      metadata: {
        source: "media-stream",
        hotelConfig: hotel,
      },
      silent: true,
    });
    let finished = false;
    let session = null;
    let voicePipeline = null;
    let recoverableErrorCount = 0;
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

      if (
        session &&
        isRecoverableVoiceError(payload) &&
        recoverableErrorCount < 2
      ) {
        recoverableErrorCount += 1;
        const sent = sendVoiceFallback(session);
        if (sent) {
          voicePipeline?.markFallback?.();
          request.log.warn(
            { callSid: call.callSid, attempt: recoverableErrorCount },
            "Recoverable voice error — sent spoken fallback"
          );
          return;
        }
      }

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

      // Per-call agent with hotel-scoped prompt. Same Realtime voice pipeline.
      const receptionistAgent = createReceptionistAgent(hotel);

      session = new RealtimeSession(receptionistAgent, {
        transport,
        ...realtimeSessionConfig,
        context: {
          reservationDraftHolder,
          hotelId: hotel.id,
          guestPhoneHint: null,
        },
      });

      voicePipeline = attachVoicePipeline(session, call, {
        logger: request.log,
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
              hotelId: call.hotelId || hotel.id,
              hotelPhone: call.hotelPhone,
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

        // Stream Parameter hotelId must match the session hotel (isolation check).
        const paramHotelId = startMeta.customParameters?.hotelId || null;
        if (paramHotelId && paramHotelId !== hotel.id) {
          request.log.error(
            { paramHotelId, sessionHotelId: hotel.id },
            "hotelId mismatch between stream parameter and session — closing"
          );
          handleCallError(
            new Error("Hotel ID mismatch on media stream"),
            "Hotel isolation error"
          );
          return;
        }

        mergeCallMetadata(call, {
          hotelId: hotel.id,
          metadata: {
            streamSid: startMeta.streamSid,
            customParameters: startMeta.customParameters,
            hotelConfig: hotel,
          },
        });

        // Seed phone hint for reservation draft (outbound: guest is To).
        const guestPhoneHint =
          call.direction === "outbound-api" || call.direction === "outbound"
            ? call.to
            : call.from;
        if (session?.context?.context) {
          session.context.context.guestPhoneHint = guestPhoneHint || null;
          session.context.context.hotelId = hotel.id;
        }

        announceCallStarted(call);

        request.log.info(
          {
            callSid: call.callSid,
            streamSid: startMeta.streamSid,
            hotelId: hotel.id,
          },
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
        request.log.info(
          { callSid: call.callSid, hotelId: call.hotelId },
          "Media stream WebSocket closed"
        );
        voicePipeline?.persistMetrics?.();
        safeFinish(call.errors.length > 0 ? "error" : "completed");
        try {
          session?.close?.();
        } catch {
          // ignore
        }
      });

      session.connect({ apiKey: config.openaiApiKey }).then(
        () => {
          voicePipeline?.onConnected?.();
          request.log.info(
            {
              callSid: call.callSid,
              hotelId: hotel.id,
              hotelName: hotel.hotel?.name,
              vadEagerness: voiceConfig.vadEagerness,
              outputSpeed: voiceConfig.outputSpeed,
            },
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
    console.log(
      `Hotels loaded: ${listHotels().map((h) => h.id).join(", ") || "(none)"}`
    );
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
