import test from "node:test";
import assert from "node:assert/strict";
import {
  containsNewQuestion,
  createConversationState,
  decideTurnPolicy,
  detectDuplicateBookingCompletion,
  detectForcedBookingReturn,
  detectHallucinatedUnclearIntent,
  detectTopic,
  detectUnclearSpeechTreatedAsUnknown,
  hasConfirmationAndNewQuestion,
  isExplicitFarewell,
  isSoftAcknowledgement,
  isUnclearSpeech,
  resolveFollowUpIntent,
  updateConversationState,
} from "../src/conversation.js";
import {
  applyReservationDraftUpdate,
  createEmptyReservationDraft,
  extractReservationFieldsFromText,
  serializeReservationDraft,
} from "../src/reservation.js";
import { buildCallQa } from "../src/qa.js";
import {
  RECEPTIONIST_VOICE,
  realtimeSessionConfig,
} from "../src/agent.js";

test("1. unclear ASR -> clarification, not hallucinated intent", () => {
  assert.equal(isUnclearSpeech("А підз'ю камузна можна?"), true);
  const policy = decideTurnPolicy("А підз'ю камузна можна?");
  assert.equal(policy.action, "clarify");
  assert.equal(policy.doNotGuess, true);

  const hallucinated = detectHallucinatedUnclearIntent([
    { speaker: "caller", text: "А підз'ю камузна можна?" },
    {
      speaker: "assistant",
      text: "Так, можна записатися на процедури напряму в SPA-зоні.",
    },
  ]);
  assert.equal(hallucinated.length, 1);
});

test("2. unclear ASR with strong SPA context -> confirmation question", () => {
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "А є у вас спа?",
  });
  const policy = decideTurnPolicy("А підз'ю камузна можна?", state);
  assert.equal(policy.action, "confirm_interpretation");
  assert.match(policy.clarification, /SPA/i);
});

test("3. new topic interrupts unfinished booking", () => {
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "Хочу забронювати номер.",
  });
  const draft = applyReservationDraftUpdate(createEmptyReservationDraft(), {
    checkIn: "15 серпня",
    checkOut: "18 серпня",
    guests: 2,
    roomType: "deluxe",
    status: "collecting",
  });
  const policy = decideTurnPolicy(
    "А є у вас зарядка для електромобіля?",
    state,
    draft
  );
  assert.equal(policy.action, "answer_topic");
  assert.equal(policy.topic, "ev_charging");
  assert.equal(policy.doNotForceBooking, true);
});

test("4. booking state survives topic switch", () => {
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "Хочу забронювати номер.",
  });
  assert.equal(state.bookingState, "collecting");
  state = updateConversationState(state, {
    speaker: "caller",
    text: "А є у вас спа?",
  });
  assert.equal(state.currentTopic, "spa");
  assert.equal(state.bookingState, "collecting");
});

test("5. mid-call greeting does not restart conversation", () => {
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "Добрий день.",
  });
  const policy = decideTurnPolicy("Добрий день.", state);
  assert.equal(policy.action, "mid_call_greeting");
  assert.equal(policy.doNotRestart, true);
  assert.equal(policy.preserveReservation, true);
});

test("6. Добре does not trigger farewell", () => {
  assert.equal(isSoftAcknowledgement("Добре."), true);
  assert.equal(isExplicitFarewell("Добре."), false);
  assert.equal(decideTurnPolicy("Добре.").action, "soft_ack");
  assert.equal(decideTurnPolicy("Добре.").doNotEnd, true);
});

test("7. Супер does not trigger farewell", () => {
  assert.equal(isSoftAcknowledgement("Супер."), true);
  assert.equal(isExplicitFarewell("Супер."), false);
  assert.equal(decideTurnPolicy("Супер.").action, "soft_ack");
});

test("8. Дякую, а ще... is not farewell", () => {
  assert.equal(containsNewQuestion("Дякую. А ще скажіть, чи є SPA?"), true);
  assert.equal(isExplicitFarewell("Дякую. А ще скажіть, чи є SPA?"), false);
  const policy = decideTurnPolicy("Дякую. А ще скажіть, чи є SPA?");
  assert.equal(policy.action, "answer_topic");
  assert.equal(policy.topic, "spa");
});

test("9. explicit farewell ends conversation", () => {
  assert.equal(isExplicitFarewell("До побачення."), true);
  assert.equal(isExplicitFarewell("Все, дякую, до побачення."), true);
  assert.equal(decideTurnPolicy("До побачення.").action, "farewell");
});

test("10. booking confirmation + new question -> answer question first", () => {
  assert.equal(
    hasConfirmationAndNewQuestion(
      "Так, все вірно. А підкажіть, яка вартість проживання за добу?"
    ),
    true
  );
  const policy = decideTurnPolicy(
    "Так, все вірно. А підкажіть, яка вартість проживання за добу?"
  );
  assert.equal(policy.priority, "question_first");
  assert.equal(policy.action, "answer_topic");
});

test("11. multiple questions in one turn are both detected", () => {
  const text = "Яка ціна делюксу і чи є сніданок?";
  assert.equal(detectTopic(text), "breakfast");
  assert.match(text, /делюкс/);
  assert.match(text, /снідан/);
});

test("12. latest booking correction wins", () => {
  let draft = applyReservationDraftUpdate(createEmptyReservationDraft(), {
    checkOut: "18 серпня",
    status: "awaiting_confirmation",
  });
  const patch = extractReservationFieldsFromText("Ні-ні, виїзд 17-го.");
  draft = applyReservationDraftUpdate(draft, patch);
  assert.equal(draft.checkOut, "17");
});

test("13. unknown knowledge fallback", () => {
  const policy = decideTurnPolicy("Чи є у вас більярд?");
  assert.equal(policy.action, "answer_topic");
  assert.notEqual(policy.action, "clarify");
});

test("14. unclear speech != unknown knowledge", () => {
  assert.equal(isUnclearSpeech("А підз'ю камузна можна?"), true);
  assert.equal(isUnclearSpeech("Чи є у вас більярд?"), false);
  const bad = detectUnclearSpeechTreatedAsUnknown([
    { speaker: "caller", text: "А підз'ю камузна можна?" },
    {
      speaker: "assistant",
      text: "У моїх поточних даних немає цієї інформації, тому не хочу вас вводити в оману.",
    },
  ]);
  assert.equal(bad.length, 1);
});

test("15. no duplicate booking completion responses", () => {
  const dups = detectDuplicateBookingCompletion([
    {
      speaker: "assistant",
      text: "Делюкс коштує 3800 гривень за ніч. Тоді підтверджую дані.",
    },
    {
      speaker: "assistant",
      text: "Добре, дані записала. У цій тестовій версії реальне бронювання ще не створюється, але всі дані для нього збережені.",
    },
  ]);
  assert.ok(dups.length > 1);
});

test("16. reservation remains confirmed after post-confirmation question", () => {
  let draft = applyReservationDraftUpdate(createEmptyReservationDraft(), {
    checkIn: "15 серпня",
    checkOut: "17 серпня",
    guests: 2,
    roomType: "deluxe",
    guestName: "Стівен",
    status: "confirmed_for_test",
  });
  const before = serializeReservationDraft(draft);
  const policy = decideTurnPolicy("А яка вартість сніданку?", createConversationState(), draft);
  assert.equal(policy.preserveReservation, true);
  assert.equal(policy.action, "answer_topic");
  assert.equal(policy.topic, "breakfast");
  assert.equal(draft.status, "confirmed_for_test");
  assert.equal(serializeReservationDraft(draft).status, before.status);
});

test("17. follow-up inherits current topic", () => {
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "А є у вас спа?",
  });
  const follow = resolveFollowUpIntent("А після десяти?", state);
  assert.equal(follow.type, "followup_current_topic");
  assert.equal(follow.topic, "spa");
});

test("18. new topic does not erase reservation state", () => {
  const draft = applyReservationDraftUpdate(createEmptyReservationDraft(), {
    checkIn: "15 серпня",
    checkOut: "18 серпня",
    guests: 2,
    roomType: "deluxe",
    status: "collecting",
  });
  let state = createConversationState();
  state = updateConversationState(state, {
    speaker: "caller",
    text: "Хочу забронювати.",
  });
  state = updateConversationState(state, {
    speaker: "caller",
    text: "А є у вас зарядка для електромобіля?",
  });
  assert.equal(state.bookingState, "collecting");
  assert.equal(draft.checkIn, "15 серпня");
  assert.equal(draft.roomType, "deluxe");
  assert.equal(draft.guestName, null);

  const forced = detectForcedBookingReturn([
    { speaker: "caller", text: "А є у вас зарядка для електромобіля?" },
    {
      speaker: "assistant",
      text: "Нам залишилося уточнити ім'я для бронювання. Як вас звати?",
    },
  ]);
  assert.equal(forced.length, 1);
});

test("extracts numeric stay range and guest name", () => {
  const dates = extractReservationFieldsFromText("на 15 по 18 серпня");
  assert.equal(dates.checkIn, "15 серпня");
  assert.equal(dates.checkOut, "18 серпня");
  const name = extractReservationFieldsFromText("Добре, дякую. Мене звати Стівен.");
  assert.equal(name.guestName, "Стівен");
  const guests = extractReservationFieldsFromText("Двое.");
  assert.equal(guests.guests, 2);
});

test("QA flags real-call failure modes", () => {
  const qa = buildCallQa({
    transcript: [
      { speaker: "caller", text: "А підз'ю камузна можна?" },
      {
        speaker: "assistant",
        text: "Так, можна записатися на процедури напряму в SPA-зоні.",
      },
      { speaker: "caller", text: "А є у вас зарядка для електромобіля?" },
      {
        speaker: "assistant",
        text: "Нам залишилося уточнити ім'я для бронювання. Як вас звати?",
      },
    ],
  });
  assert.ok(qa.unclear_speech_hallucinated_intent >= 1);
  assert.ok(qa.forced_booking_return >= 1);
});

test("V1.2 config unchanged", () => {
  assert.equal(RECEPTIONIST_VOICE, "coral");
  assert.equal(realtimeSessionConfig.model, "gpt-realtime");
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
});
