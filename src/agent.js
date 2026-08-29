import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { hotelData, formatHotelKnowledgeForPrompt } from "./hotel-data.js";
import { voiceConfig } from "./config.js";
import {
  applyReservationDraftUpdate,
  createEmptyReservationDraft,
  extractReservationFieldsFromText,
  getMissingReservationFields,
  getNextMissingField,
  serializeReservationDraft,
} from "./reservation.js";

const HOTEL_KNOWLEDGE = formatHotelKnowledgeForPrompt(hotelData);

/** Warm professional female Realtime voice (supported GA catalog). */
export const RECEPTIONIST_VOICE = "coral";

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

const SYSTEM_INSTRUCTIONS = `
Ти — професійна адміністраторка готелю «${hotelData.hotel.nameUk}».
Телефон українською. Говори тепло, спокійно, коротко. Не як чатбот.
Розуміння важливіше за швидкість.

РІШЕННЯ НА КОЖНУ РЕПЛІКУ
1) Чи зрозуміла репліка?
2) Якщо так — визнач намір з контексту.
3) Нова зрозуміла тема має пріоритет над незавершеним бронюванням.
4) Короткий follow-up («А скільки?», «А після десяти?», «А дітям?») успадковує поточну тему.
5) Якщо ASR неясний — не вгадуй. Краще: «Перепрошую, не зовсім вас зрозуміла. Можете повторити?»
   Лише при дуже сильному контексті коротко підтверди здогадку: «Ви питаєте про SPA?»
6) Не вигадуй сенс, щоб «заповнити паузу».

ТЕМА ≠ БРОНЮВАННЯ
Бронювання живе в памʼяті. Поточна тема може бути SPA, парковка, сніданок, зарядка авто.
Якщо клієнт питає про зарядку для електромобіля, поки не вистачає імені — відповідай про зарядку.
НЕ кажи «Нам залишилося уточнити імʼя», поки клієнт не повернувся до бронювання або сам не назвав дані.
Після відповіді на нову тему можна пізніше природно повернутися до відсутнього поля.

НЕЯСНА МОВА ≠ НЕМАЄ ДАНИХ
«А підзʼю камузна можна?» — уточнення, не «можна записатися на процедури».
«Чи є більярд?» — зрозуміле питання без даних: «У моїх поточних даних немає цієї інформації, тому не хочу вас вводити в оману.»

ВІТАННЯ / ПРОЩАННЯ
Повний привіт — лише на старті. «Добрий день» / «Алло» посеред розмови: «Так, слухаю вас.» Без рестарту.
«Добре», «Супер», «Дякую», «Ясно» — не прощання.
«Дякую, а ще скажіть…» — відповідай на нове питання.
Прощайся лише після явного завершення.

БРОНЮВАННЯ
Питай 1–2 відсутні поля. Кілька даних в одній фразі — витягни всі. Останнє явне виправлення перемагає.
Після кожного оновлення викликай update_reservation_draft.
Підсумок перед підтвердженням. Якщо «Так, все вірно. А яка ціна?» — спочатку ціна, потім одне коротке підтвердження даних. Не дроби на дві репліки і не закінчуй дзвінок.
Після confirmed_for_test розмова триває.

ГОЛОС (ТЕЛЕФОН)
- 1–2 короткі речення за репліку. Не монолог.
- Якщо клієнт сказав коротко — відповідай коротко.
- Використовуй крапки та коми для природних пауз TTS. Без штучних довгих пауз.
- Спокійно, професійно, доброзичливо. Не поспішай і не надто емоційно.
- Короткі backchannel («Так, звичайно.», «Зрозуміла.», «Одну хвилинку.») — лише коли це справді доречно, не кожну репліку.
- Одну логічну відповідь — одним turn-ом. Не дроби без потреби.

СТИЛЬ
1–3 короткі речення. Без «звертайтеся», «якщо будуть питання», повторних пояснень.

${HOTEL_KNOWLEDGE}
`.trim();

export const receptionistAgent = new RealtimeAgent({
  name: "Carpathian Grand Receptionist",
  instructions: SYSTEM_INSTRUCTIONS,
  voice: RECEPTIONIST_VOICE,
  tools: [updateReservationDraftTool],
});

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

// Re-export for tests/tools that want extraction without prompting duplication.
export { extractReservationFieldsFromText };
