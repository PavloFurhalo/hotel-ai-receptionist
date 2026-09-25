import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { voiceConfig } from "./config.js";
import {
  buildSystemPrompt,
  getHotelById,
  formatHotelKnowledgeForPrompt,
} from "./hotels/registry.js";
import {
  applyReservationDraftUpdate,
  createEmptyReservationDraft,
  extractReservationFieldsFromText,
  getMissingReservationFields,
  getNextMissingField,
  serializeReservationDraft,
} from "./reservation.js";

/** Natural warm female Realtime voice (env: REALTIME_VOICE). */
export const RECEPTIONIST_VOICE = voiceConfig.voice;

const ASR_PROMPT = [
  "Ukrainian hotel reception phone call.",
  "Prefer hotel vocabulary when acoustically plausible:",
  "готель, рецепція, номер, кімната, стандартний номер, делюкс, сімейний номер,",
  "бронювання, забронювати, бронь, заїзд, виїзд, заселення, виселення, чек-ін, чек-аут,",
  "SPA, спа, сауна, басейн, парковка, паркінг, сніданок, ресторан, бар, більярд,",
  "ціна, вартість, гривень, дитина, додаткове ліжко.",
  "Expect conversational Ukrainian, surzhyk, incomplete sentences, and phone audio.",
  "Do not invent words that were not spoken.",
].join(" ");

const updateReservationDraftTool = tool({
  name: "update_reservation_draft",
  description:
    "Update the prototype reservation draft with fields the caller explicitly provided or clearly confirmed. Call after each new booking detail or correction. Latest explicit value wins. Never invent missing values. Keep relative dates as spoken. Use nights when caller gives duration instead of checkout. Status: collecting while gathering, awaiting_confirmation when summarizing, confirmed_for_test only after explicit confirmation.",
  parameters: z.object({
    checkIn: z.string().nullable().optional(),
    checkOut: z.string().nullable().optional(),
    nights: z.number().int().positive().nullable().optional(),
    guests: z.number().int().positive().nullable().optional(),
    roomType: z.enum(["standard", "deluxe", "family"]).nullable().optional(),
    guestName: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    status: z.enum([
      "collecting",
      "awaiting_confirmation",
      "confirmed_for_test",
    ]),
  }),
  execute: async (input, runContext) => {
    const holder = runContext?.context?.reservationDraftHolder;
    if (!holder) {
      return "Reservation draft storage is unavailable.";
    }

    if (!holder.draft) {
      holder.draft = createEmptyReservationDraft({
        phone: runContext?.context?.guestPhoneHint || null,
      });
    }

    holder.draft = applyReservationDraftUpdate(holder.draft, input);
    const snapshot = serializeReservationDraft(holder.draft);
    const missing = getMissingReservationFields(holder.draft);

    console.log("\nRESERVATION DRAFT UPDATED:");
    console.log(JSON.stringify(snapshot, null, 2));

    return JSON.stringify({
      ok: true,
      reservationDraft: snapshot,
      missing,
      nextMissingField: getNextMissingField(holder.draft),
      readyForConfirmation: missing.length === 0,
    });
  },
});

/**
 * Create a RealtimeAgent bound to one hotel configuration.
 * Voice pipeline (tools / VAD / ASR) stays shared; prompt is hotel-scoped.
 */
export function createReceptionistAgent(hotelConfig) {
  if (!hotelConfig?.id || !hotelConfig?.hotel?.nameUk) {
    throw new Error("createReceptionistAgent requires a valid hotel config.");
  }

  const instructions = buildSystemPrompt(hotelConfig);

  return new RealtimeAgent({
    name: `${hotelConfig.hotel.name} Receptionist`,
    instructions,
    voice: RECEPTIONIST_VOICE,
    tools: [updateReservationDraftTool],
  });
}

/**
 * Supported by @openai/agents-realtime 0.14.3.
 * Keep conservative phone turn-taking.
 */
export const realtimeSessionConfig = {
  model: "gpt-realtime",
  config: {
    audio: {
      input: {
        transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "uk",
          prompt: ASR_PROMPT,
        },
        turnDetection: {
          type: "semantic_vad",
          eagerness: voiceConfig.vadEagerness,
          createResponse: true,
          interruptResponse: true,
        },
      },
      output: {
        voice: RECEPTIONIST_VOICE,
        speed: voiceConfig.outputSpeed,
      },
    },
  },
};

/** Default hotel for backward-compatible unit tests. */
export function getDefaultHotelConfig() {
  return getHotelById("grand-hotel-lviv");
}

/**
 * @deprecated Prefer createReceptionistAgent(hotelConfig) per call.
 * Kept for older tests that import a singleton.
 */
export const receptionistAgent = createReceptionistAgent(getDefaultHotelConfig());

export { buildSystemPrompt, formatHotelKnowledgeForPrompt };
export { extractReservationFieldsFromText };
