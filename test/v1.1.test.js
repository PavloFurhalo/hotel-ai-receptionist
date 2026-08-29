import test from "node:test";
import assert from "node:assert/strict";
import {
  createConversationState,
  detectPrematureAssistantReplies,
  detectPrematureFarewells,
  detectUnclearSpeechTreatedAsUnknown,
  isExplicitFarewell,
  isGreetingUtterance,
  isIncompleteUtterance,
  isSoftAcknowledgement,
  isUnclearSpeech,
  resolveFollowUpIntent,
  updateConversationState,
} from "../src/conversation.js";
import {
  applyReservationDraftUpdate,
  createEmptyReservationDraft,
  detectBookingFieldRegression,
  extractReservationFieldsFromText,
  getMissingReservationFields,
  getNextMissingField,
  serializeReservationDraft,
} from "../src/reservation.js";
import { buildCallQa } from "../src/qa.js";
import {
  RECEPTIONIST_VOICE,
  realtimeSessionConfig,
} from "../src/agent.js";

test("V1.1 Test1: incomplete А... then booking intent", () => {
  assert.equal(isIncompleteUtterance("А..."), true);
  assert.equal(isIncompleteUtterance("Я хотів..."), true);
  assert.equal(isIncompleteUtterance("Я хотів забронювати номер."), false);
  const intent = resolveFollowUpIntent("Я хотів забронювати номер.");
  assert.ok(intent.type === "topic" || intent.type === "followup_booking");
});

test("V1.1 Test2: family room then А на двох uses context", () => {
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "Сімейний номер.",
  });
  assert.equal(state.lastRoomMentioned, "family");
  const follow = resolveFollowUpIntent("А на двох?", state);
  assert.equal(follow.type, "followup_occupancy");
  assert.equal(follow.roomType, "family");
  assert.equal(follow.guests, 2);
});

test("V1.1 Test3: unclear ASR during booking asks clarification", () => {
  assert.equal(isUnclearSpeech("спалховик вартість номеру?"), true);
  const intent = resolveFollowUpIntent("спалховик вартість номеру?");
  assert.equal(intent.type, "unclear_speech");
  assert.match(intent.clarification, /вартість номера/i);

  const qa = buildCallQa({
    transcript: [
      { speaker: "caller", text: "спалховик вартість номеру?" },
      {
        speaker: "assistant",
        text: "У моїх поточних даних немає цієї інформації, тому не хочу вас вводити в оману.",
      },
    ],
  });
  assert.ok(qa.ambiguous_speech_handled_as_unknown_knowledge >= 1);
});

test("V1.1 Test4: guest correction latest wins", () => {
  let draft = createEmptyReservationDraft();
  draft = applyReservationDraftUpdate(draft, { guests: 2, status: "collecting" });
  draft = applyReservationDraftUpdate(draft, { guests: 3, status: "collecting" });
  assert.equal(draft.guests, 3);
});

test("V1.1 Test5: post-confirmation parking is not farewell", () => {
  const transcript = [
    {
      speaker: "assistant",
      text: "Добре, дані записала. У цій тестовій версії реальне бронювання ще не створюється, але всі дані для нього збережені.",
    },
    { speaker: "caller", text: "А паркінг є?" },
    {
      speaker: "assistant",
      text: "Так, є закрите паркування на території за 200 гривень на добу.",
    },
  ];
  const farewells = detectPrematureFarewells(transcript);
  assert.equal(farewells.length, 0);
  const qa = buildCallQa({
    transcript,
    reservationDraft: {
      status: "confirmed_for_test",
      checkIn: "пʼятниця",
      nights: 1,
      guests: 2,
      roomType: "family",
      guestName: "Анатолій",
    },
  });
  assert.equal(qa.post_confirmation_premature_end, 0);
});

test("V1.1 Test6: Добре is not farewell", () => {
  assert.equal(isSoftAcknowledgement("Добре."), true);
  assert.equal(isExplicitFarewell("Добре."), false);
});

test("V1.1 Test7: explicit farewell", () => {
  assert.equal(isExplicitFarewell("Дякую, все. До побачення."), true);
});

test("V1.1 Test8: mid-call greeting is not farewell/restart", () => {
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "Добрий вечір.",
  });
  assert.equal(state.greeted, true);
  const mid = resolveFollowUpIntent("Добрий день.", state);
  assert.equal(mid.type, "mid_call_greeting");
  assert.equal(isGreetingUtterance("Добрий день."), true);
  assert.equal(isExplicitFarewell("Добрий день."), false);
});

test("V1.1 Test9: unclear speech vs unknown knowledge", () => {
  assert.equal(isUnclearSpeech("спалховик вартість номеру?"), true);
  assert.equal(isUnclearSpeech("Чи є у вас більярд?"), false);
  const bad = detectUnclearSpeechTreatedAsUnknown([
    { speaker: "caller", text: "спалховик вартість номеру?" },
    {
      speaker: "assistant",
      text: "У моїх поточних даних немає цієї інформації, тому не хочу вас вводити в оману.",
    },
  ]);
  assert.equal(bad.length, 1);
});

test("V1.1 Test10: А скільки inherits family room", () => {
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "Скільки коштує сімейний номер?",
  });
  const follow = resolveFollowUpIntent("А скільки?", state);
  assert.equal(follow.type, "followup_price");
  assert.equal(follow.roomType, "family");
});

test("V1.1 Test11: multi-field extraction in one sentence", () => {
  const patch = extractReservationFieldsFromText(
    "Хочу сімейний на двох з п'ятниці до суботи, на Анатолія."
  );
  assert.equal(patch.roomType, "family");
  assert.equal(patch.guests, 2);
  assert.equal(patch.checkIn, "п'ятниці");
  assert.equal(patch.checkOut, "суботи");
  assert.equal(patch.guestName, "Анатолія");
  const draft = applyReservationDraftUpdate(createEmptyReservationDraft(), patch);
  const missing = getMissingReservationFields(draft);
  assert.ok(!missing.includes("roomType"));
  assert.ok(!missing.includes("guests"));
  assert.ok(!missing.includes("checkIn"));
  assert.equal(getNextMissingField(draft), null);
});

test("V1.1 Test12: room type correction latest wins", () => {
  let draft = applyReservationDraftUpdate(createEmptyReservationDraft(), {
    roomType: "family",
    status: "collecting",
  });
  draft = applyReservationDraftUpdate(draft, {
    roomType: "deluxe",
    status: "collecting",
  });
  assert.equal(draft.roomType, "deluxe");
  assert.deepEqual(
    detectBookingFieldRegression(
      { roomType: "family" },
      { roomType: "deluxe" }
    ),
    []
  );
  assert.deepEqual(
    detectBookingFieldRegression({ guests: 2 }, { guests: null }),
    ["guests"]
  );
});

test("V1.1 nights vs checkout wording", () => {
  let draft = applyReservationDraftUpdate(createEmptyReservationDraft(), {
    checkIn: "пʼятниця",
    nights: 1,
    guests: 2,
    roomType: "family",
    guestName: "Анатолій",
    status: "awaiting_confirmation",
  });
  assert.equal(getMissingReservationFields(draft).length, 0);
  assert.equal(serializeReservationDraft(draft).nights, 1);

  const qa = buildCallQa({
    transcript: [
      {
        speaker: "assistant",
        text: "Перевірю: заїзд у пʼятницю, виїзд на одну ніч, двоє гостей.",
      },
    ],
  });
  assert.ok(qa.incorrect_checkout_wording >= 1);
});

test("V1.1 premature farewell after soft ack", () => {
  const events = detectPrematureFarewells([
    { speaker: "caller", text: "Добре." },
    {
      speaker: "assistant",
      text: "Гарного дня, буду рада допомогти ще. До побачення!",
    },
  ]);
  assert.equal(events.length, 1);
});

test("V1.1 config unchanged", () => {
  assert.equal(RECEPTIONIST_VOICE, "coral");
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
    "low"
  );
  assert.equal(detectPrematureAssistantReplies([]), 0);
});
