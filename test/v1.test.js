import test from "node:test";
import assert from "node:assert/strict";
import {
  isIncompleteUtterance,
  isExplicitFarewell,
  isBookingIntent,
  isAvailabilityQuestion,
  sortTranscript,
  looksLikeTopicJump,
  detectPrematureAssistantReplies,
} from "../src/conversation.js";
import {
  applyReservationDraftUpdate,
  createEmptyReservationDraft,
  getMissingReservationFields,
  isReservationReadyForConfirmation,
  serializeReservationDraft,
} from "../src/reservation.js";
import { buildCallQa } from "../src/qa.js";
import {
  createCallLog,
  addTranscriptEntry,
  finishCall,
  recordInterruption,
} from "../src/call-logger.js";
import {
  RECEPTIONIST_VOICE,
  realtimeSessionConfig,
} from "../src/agent.js";
import { voiceConfig } from "../src/config.js";
import { hotelData } from "../src/hotel-data.js";

test("1. context handling: booking follow-up is booking intent, not pets", () => {
  assert.equal(isBookingIntent("А можна забронювати?"), true);
  assert.equal(looksLikeTopicJump("А можна забронювати?", "Домашні тварини не дозволені."), true);
  assert.equal(
    looksLikeTopicJump(
      "А можна забронювати?",
      "Зараз я не можу оформити бронювання безпосередньо через цю систему."
    ),
    false
  );
});

test("2. reservation draft merge never invents empty fields", () => {
  let draft = createEmptyReservationDraft();
  draft = applyReservationDraftUpdate(draft, {
    checkIn: "наступна пʼятниця",
    status: "collecting",
  });
  assert.equal(draft.checkIn, "наступна пʼятниця");
  assert.equal(draft.checkOut, null);
  assert.equal(draft.guests, null);
});

test("3. booking state transitions and readiness", () => {
  let draft = createEmptyReservationDraft({ phone: "+380677486490" });
  draft = applyReservationDraftUpdate(draft, {
    checkIn: "20 серпня",
    checkOut: "23 серпня",
    guests: 3,
    roomType: "family",
    guestName: "Павло",
    status: "awaiting_confirmation",
  });
  assert.equal(isReservationReadyForConfirmation(draft), true);
  draft = applyReservationDraftUpdate(draft, { status: "confirmed_for_test" });
  assert.equal(draft.status, "confirmed_for_test");
});

test("3b. nights satisfies stay length without checkout", () => {
  let draft = applyReservationDraftUpdate(createEmptyReservationDraft(), {
    checkIn: "пʼятниця",
    nights: 1,
    guests: 2,
    roomType: "family",
    guestName: "Анатолій",
    status: "collecting",
  });
  assert.equal(isReservationReadyForConfirmation(draft), true);
});

test("4. missing fields detection", () => {
  const draft = applyReservationDraftUpdate(createEmptyReservationDraft(), {
    checkIn: "завтра",
    status: "collecting",
  });
  const missing = getMissingReservationFields(draft);
  assert.deepEqual(missing, [
    "checkOutOrNights",
    "guests",
    "roomType",
    "guestName",
  ]);
});

test("5. explicit confirmation vs soft acknowledgements", () => {
  assert.equal(isExplicitFarewell("Дякую, все, до побачення."), true);
  assert.equal(isExplicitFarewell("Добре."), false);
  assert.equal(isExplicitFarewell("Супер."), false);
  assert.equal(isExplicitFarewell("Дякую."), false);
});

test("6. farewell detection patterns", () => {
  assert.equal(isExplicitFarewell("До побачення"), true);
  assert.equal(isExplicitFarewell("Все, більше питань немає"), true);
  assert.equal(isIncompleteUtterance("Добре"), true);
});

test("7. unknown / availability helpers", () => {
  assert.equal(isAvailabilityQuestion("Чи є вільний стандартний номер?"), true);
  assert.ok(hotelData.unknownTopics.includes("більярд"));
  assert.equal(hotelData.capabilities.canCheckLiveAvailability, false);
});

test("8. transcript sorting is chronological", () => {
  const sorted = sortTranscript([
    { timestamp: "2026-08-10T21:00:02.000Z", speaker: "assistant", text: "B" },
    { timestamp: "2026-08-10T21:00:01.000Z", speaker: "caller", text: "A" },
  ]);
  assert.equal(sorted[0].text, "A");
  assert.equal(sorted[1].text, "B");
});

test("9. call log serialization includes reservationDraft + qa", async () => {
  const call = createCallLog({
    callSid: "CA_V1_UNIT",
    from: "+14066294775",
    to: "+380677486490",
    direction: "outbound-api",
    silent: true,
  });
  addTranscriptEntry(call, "caller", "Хочу забронювати сімейний номер", {
    itemId: "c1",
  });
  addTranscriptEntry(
    call,
    "assistant",
    "Звісно. На яку дату плануєте заїзд?",
    { itemId: "a1" }
  );
  recordInterruption(call, { callerTranscript: "Хочу забронювати сімейний номер" });

  call.reservationDraft = serializeReservationDraft(
    applyReservationDraftUpdate(createEmptyReservationDraft(), {
      roomType: "family",
      guests: 3,
      checkIn: "20 серпня",
      checkOut: "22 серпня",
      guestName: "Олена",
      phone: "+380677486490",
      status: "confirmed_for_test",
    })
  );

  const saved = await finishCall(call);
  assert.equal(saved.reservationDraft.roomType, "family");
  assert.ok(saved.qa);
  assert.equal(typeof saved.qa.overallScore, "number");
  assert.equal(saved.metadata.interruptions, 1);
  assert.equal(saved.metadata.interruptionEvents.length, 1);
});

test("10. QA metrics detect premature replies and context jumps", () => {
  const transcript = [
    { timestamp: "1", speaker: "caller", text: "А..." },
    {
      timestamp: "2",
      speaker: "assistant",
      text: "Стандартний номер коштує 2500 гривень за ніч.",
    },
    { timestamp: "3", speaker: "caller", text: "А можна забронювати?" },
    {
      timestamp: "4",
      speaker: "assistant",
      text: "Домашні тварини в нашому готелі не дозволені.",
    },
  ];
  const qa = buildCallQa({
    transcript,
    reservationDraft: null,
    metadata: { interruptions: 4 },
    errors: [],
  });
  assert.ok(qa.prematureResponses >= 1);
  assert.ok(qa.contextErrors >= 1);
  assert.equal(qa.interruptions, 4);
  assert.ok(qa.overallScore < 100);
});

test("config invariants for V1", () => {
  assert.equal(RECEPTIONIST_VOICE, voiceConfig.voice);
  assert.equal(realtimeSessionConfig.model, "gpt-realtime");
  assert.equal(
    realtimeSessionConfig.config.audio.input.transcription.model,
    "gpt-4o-mini-transcribe"
  );
  assert.equal(
    realtimeSessionConfig.config.audio.input.transcription.language,
    "uk"
  );
  assert.equal(
    realtimeSessionConfig.config.audio.input.turnDetection.type,
    "semantic_vad"
  );
  assert.equal(
    realtimeSessionConfig.config.audio.input.turnDetection.eagerness,
    voiceConfig.vadEagerness
  );
  assert.equal(realtimeSessionConfig.config.audio.output.voice, voiceConfig.voice);
  assert.equal(detectPrematureAssistantReplies([]), 0);
});
