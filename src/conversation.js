/**
 * Deterministic conversation helpers for receptionist behavior + local QA.
 * No OpenAI/Twilio calls.
 */

import { hotelData } from "./hotel-data.js";

function unknownTopicsFor(hotelConfig = hotelData) {
  return hotelConfig?.unknownTopics || hotelData?.unknownTopics || [];
}

const INCOMPLETE_UTTERANCES = [
  "а",
  "ем",
  "мм",
  "ну",
  "так",
  "ні",
  "ще",
  "і",
  "тобто",
  "гар",
  "добре",
  "супер",
  "чудово",
  "ясно",
  "зрозуміло",
  "секунду",
  "зараз",
  "я хотів",
  "я хотіла",
  "скажіть",
  "підкажіть",
  "мені треба",
  "можна",
  "чи можна",
];

const SOFT_ACKNOWLEDGEMENTS = [
  "добре",
  "супер",
  "чудово",
  "так",
  "ясно",
  "зрозуміло",
  "зрозумів",
  "зрозуміла",
  "я зрозумів",
  "дякую",
  "мені підходить",
  "ок",
  "окей",
];

const GREETING_PATTERNS = [
  /^(алло[,!.]?\s*)?добрий\s+день\.?$/i,
  /^(алло[,!.]?\s*)?доброго\s+дня\.?$/i,
  /^(алло[,!.]?\s*)?добрий\s+вечір\.?$/i,
  /^(алло[,!.]?\s*)?доброго\s+вечора\.?$/i,
  /^алло\.?$/i,
  /^вітаю\.?$/i,
  /^привіт\.?$/i,
];

const FAREWELL_PATTERNS = [
  /до\s*побачення/i,
  /до\s*зустрічі/i,
  /^пока\.?$/i,
  /гарного\s+(дня|вечора)/i,
  /все\s*,?\s*дякую/i,
  /дякую\s*,?\s*все/i,
  /більше\s+питань\s+нема/i,
  /все\s*,?\s*більше\s+нічого/i,
  /дякую\s*,?\s*все\s*,?\s*до\s*побачення/i,
  /добре\s*,?\s*тоді\s+до\s*побачення/i,
];

const BOOKING_FIELD_QUESTION =
  /як\s+вас\s+звати|ім['ʼ]?я\s+для\s+брон|залишилося\s+уточнити|на\s+які\s+дати|скільки\s+гост/i;

const INVENTED_SERVICE_PATTERNS = [
  /записатися\s+на\s+процедур/i,
  /можна\s+записатися/i,
];

const BOOKING_INTENT_PATTERNS = [
  /забронюват/i,
  /бронюван/i,
  /зробити\s+брон/i,
  /оформити\s+брон/i,
  /хочу\s+заброн/i,
  /можна\s+заброн/i,
  /забронюйте/i,
  /хочу\s+(сімейний|стандартний|делюкс)?\s*номер/i,
];

const CHATBOT_FAREWELL_PATTERNS = [
  /якщо\s+будуть\s+(ще\s+)?питання/i,
  /звертайтеся/i,
  /завжди\s+рад[аі]/i,
  /буду\s+рад[аі]\s+допомогти/i,
  /гарного\s+(дня|вечора).*допомог/i,
];

const UNKNOWN_KNOWLEDGE_PATTERNS = [
  /у\s+моїх\s+поточних\s+даних\s+немає/i,
  /немає\s+цієї\s+інформації/i,
  /не\s+хочу\s+вас\s+вводити\s+в\s+оману/i,
];

export function normalizeUtterance(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?…,]+$/g, "")
    .replace(/\s+/g, " ");
}

export function isIncompleteUtterance(text) {
  const normalized = normalizeUtterance(text);
  if (!normalized) return true;
  if (normalized.length <= 2) return true;
  if (INCOMPLETE_UTTERANCES.includes(normalized)) return true;
  if (/^(а|ем|мм|ну|і|ще)\.+$/i.test(normalized)) return true;
  if (/^(я хотів|я хотіла|скажіть|підкажіть|мені треба|тобто|можна|чи можна)\.?$/i.test(normalized)) {
    return true;
  }
  // Starters without a completed request.
  if (/^(я хотів|я хотіла)\.?$/i.test(normalized)) return true;
  if (/^(я хотів|я хотіла)\s+\.\.\.?$/i.test(normalized)) return true;
  if (
    /^(скажіть|підкажіть|можна|чи можна)\b/i.test(normalized) &&
    !/[?]/.test(text) &&
    normalized.split(" ").length <= 2
  ) {
    return true;
  }
  return false;
}

export function isSoftAcknowledgement(text) {
  const normalized = normalizeUtterance(text);
  return SOFT_ACKNOWLEDGEMENTS.includes(normalized);
}

export function isGreetingUtterance(text) {
  const raw = String(text || "").trim();
  return GREETING_PATTERNS.some((pattern) => pattern.test(raw));
}

export function containsNewQuestion(text) {
  const value = String(text || "");
  return (
    /\?\s*$/.test(value) ||
    /\bа\s+(ще|яка|який|є|скільки|можна|підкаж)/i.test(value) ||
    /дякую[,.]?\s+а\s+/i.test(value)
  );
}

export function hasConfirmationAndNewQuestion(text) {
  const value = String(text || "");
  const confirms = /так[,.]?\s*все\s+(вірно|правильно)|все\s+правильно|так[,.]?\s*вірно/i.test(
    value
  );
  return confirms && containsNewQuestion(value);
}

export function isExplicitFarewell(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (isSoftAcknowledgement(raw)) return false;
  if (isGreetingUtterance(raw)) return false;
  if (containsNewQuestion(raw)) return false;
  return FAREWELL_PATTERNS.some((pattern) => pattern.test(raw));
}

export function isBookingIntent(text) {
  return BOOKING_INTENT_PATTERNS.some((pattern) =>
    pattern.test(String(text || ""))
  );
}

export function isAvailabilityQuestion(text) {
  const value = String(text || "").toLowerCase();
  return (
    /вільн/.test(value) ||
    /наявн/.test(value) ||
    /є\s+зараз/.test(value) ||
    /чи\s+є\s+.*номер/.test(value)
  );
}

/**
 * Unclear ASR / garbled speech — not the same as unknown hotel knowledge.
 */
export function isUnclearSpeech(text) {
  const raw = String(text || "").trim();
  if (!raw) return true;
  if (isIncompleteUtterance(raw)) return false;
  if (isGreetingUtterance(raw)) return false;
  if (isExplicitFarewell(raw)) return false;
  if (isSoftAcknowledgement(raw)) return false;

  const normalized = normalizeUtterance(raw);
  const tokens = normalized.split(" ").filter(Boolean);

  // Latin junk / nonsense tokens mixed into Ukrainian call.
  if (/[a-z]{5,}/i.test(raw) && !/(spa|wifi|deluxe|standard|family)/i.test(raw)) {
    return true;
  }

  // Known garbled / real-call ASR artifacts.
  if (
    /спалховик|ашхабад|ashgabat|підз['ʼ]?ю|камузн|каменюю|акула|^та,\s*двоя/i.test(
      raw
    )
  ) {
    return true;
  }

  // Mostly non-cyrillic short noise.
  const cyr = (raw.match(/[а-яіїєґ]/gi) || []).length;
  const letters = (raw.match(/[a-zа-яіїєґ]/gi) || []).length;
  if (letters >= 4 && cyr / letters < 0.4) return true;

  // Random-looking single token with hotel keyword stuck on.
  if (tokens.length <= 3 && /[а-яіїєґ]{8,}/i.test(tokens[0] || "")) {
    if (!/(стандарт|сімейн|делюкс|брон|парков|снідан|вартіст|номер)/i.test(raw)) {
      return true;
    }
  }

  return false;
}

export function likelyAsksAboutPrice(text) {
  return /вартіст|цін|скільк|кошту/i.test(String(text || ""));
}

export function createConversationState() {
  return {
    greeted: false,
    currentTopic: null,
    previousTopic: null,
    bookingState: "idle",
    unresolvedQuestion: null,
    lastRoomMentioned: null,
  };
}

export function detectTopic(text, hotelConfig = hotelData) {
  const value = String(text || "").toLowerCase();
  if (/зарядк|електромоб|електрокар/.test(value)) return "ev_charging";
  if (/wi-?fi|вай-?фай|інтернет/.test(value)) return "wifi";
  if (/парков|паркінг/.test(value)) return "parking";
  if (/снідан|харчуван/.test(value)) return "breakfast";
  if (/spa|спа/.test(value)) return "spa";
  if (/тварин|собак|кішк/.test(value)) return "pets";
  if (/ресторан|меню/.test(value)) return "restaurant";
  if (
    unknownTopicsFor(hotelConfig).some((topic) =>
      value.includes(String(topic).toLowerCase())
    )
  ) {
    return "unknown";
  }
  if (isBookingIntent(value)) return "booking";
  if (/сімейн/.test(value)) return "family_room";
  if (/делюкс|deluxe/.test(value)) return "deluxe_room";
  if (/стандарт/.test(value)) return "standard_room";
  if (/номер|кімнат|цін|вартіст|проживан/.test(value)) return "rooms";
  if (isAvailabilityQuestion(value)) return "availability";
  return null;
}

export function isClearNewTopic(text, state = createConversationState()) {
  const topic = detectTopic(text);
  if (!topic) return false;
  if (isUnclearSpeech(text) || isIncompleteUtterance(text)) return false;
  return topic !== "booking" && topic !== state.currentTopic;
}

export function updateConversationState(state, { speaker, text } = {}) {
  const next = { ...(state || createConversationState()) };
  const topic = detectTopic(text);

  if (speaker === "caller") {
    if (isGreetingUtterance(text) && !next.greeted) {
      next.greeted = true;
    }

    if (topic && topic !== next.currentTopic) {
      next.previousTopic = next.currentTopic;
      next.currentTopic = topic;
    }

    if (/сімейн/i.test(String(text || ""))) next.lastRoomMentioned = "family";
    if (/делюкс|deluxe/i.test(String(text || ""))) next.lastRoomMentioned = "deluxe";
    if (/стандарт/i.test(String(text || ""))) next.lastRoomMentioned = "standard";

    if (isBookingIntent(text) && next.bookingState === "idle") {
      next.bookingState = "collecting";
    }
    // New clear topics do not reset bookingState — reservation is memory, not topic.

    if (isUnclearSpeech(text)) {
      next.unresolvedQuestion = "unclear_speech";
    } else if (isIncompleteUtterance(text)) {
      next.unresolvedQuestion = "incomplete";
    } else {
      next.unresolvedQuestion = null;
    }
  }

  return next;
}

/**
 * Resolve short follow-ups using current conversation state.
 */
export function resolveFollowUpIntent(text, state = createConversationState()) {
  const normalized = normalizeUtterance(text);

  if (isExplicitFarewell(text)) {
    return { type: "farewell" };
  }
  if (isSoftAcknowledgement(text)) {
    return { type: "soft_ack" };
  }
  if (isGreetingUtterance(text) && state.greeted) {
    return { type: "mid_call_greeting" };
  }
  if (isIncompleteUtterance(text)) {
    return { type: "incomplete" };
  }
  if (isUnclearSpeech(text)) {
    return {
      type: "unclear_speech",
      clarification: likelyAsksAboutPrice(text)
        ? "Перепрошую, ви питаєте про вартість номера?"
        : "Перепрошую, не зовсім вас розчула. Повторіть, будь ласка.",
    };
  }

  // Short continuation: "А скільки?", "А на двох?", "А забронювати?"
  if (/^(а\s+)?скільки\??$/i.test(normalized) || /^а\s+скільки\b/i.test(normalized)) {
    return {
      type: "followup_price",
      roomType: state.lastRoomMentioned || null,
      topic: state.currentTopic,
    };
  }

  if (/^(а\s+)?на\s+двох\??$/i.test(normalized) || /на\s+двох/i.test(normalized)) {
    return {
      type: "followup_occupancy",
      roomType: state.lastRoomMentioned || null,
      guests: 2,
    };
  }

  if (/^(а\s+)?забронюват/i.test(normalized) || /^а\s+можна\s+заброн/i.test(normalized)) {
    return {
      type: "followup_booking",
      roomType: state.lastRoomMentioned || null,
    };
  }

  if (
    /^(а\s+)?(після\s+десяти|дітям|можна|є|це\s+входить|що\s+по\s+меню|який)\??$/i.test(
      normalized
    )
  ) {
    return {
      type: "followup_current_topic",
      topic: state.currentTopic,
    };
  }

  const topic = detectTopic(text);
  if (topic) {
    return { type: "topic", topic };
  }

  return { type: "general" };
}

export function strongContextualGuess(text, state = createConversationState()) {
  if (!isUnclearSpeech(text)) return null;
  if (state.currentTopic === "spa" && /можна/i.test(String(text || ""))) {
    return {
      topic: "spa",
      clarification: "Перепрошую, не зовсім вас зрозуміла. Ви питаєте про SPA?",
    };
  }
  if (likelyAsksAboutPrice(text)) {
    return {
      topic: "rooms",
      clarification: "Перепрошую, ви питаєте про вартість номера?",
    };
  }
  return null;
}

/**
 * V1.2 turn policy: understand first; new clear topic beats unfinished booking.
 */
export function decideTurnPolicy(text, state = createConversationState(), reservation = null) {
  if (hasConfirmationAndNewQuestion(text)) {
    return {
      action: "answer_topic",
      topic: detectTopic(text) || "rooms",
      alsoConfirmBooking: true,
      priority: "question_first",
      preserveReservation: true,
    };
  }

  if (isExplicitFarewell(text)) {
    return { action: "farewell" };
  }

  if (isSoftAcknowledgement(text)) {
    return { action: "soft_ack", preserveReservation: true, doNotEnd: true };
  }

  if (isGreetingUtterance(text) && state.greeted) {
    return {
      action: "mid_call_greeting",
      preserveReservation: true,
      doNotRestart: true,
    };
  }

  if (isIncompleteUtterance(text)) {
    return { action: "listen" };
  }

  if (isUnclearSpeech(text)) {
    const guess = strongContextualGuess(text, state);
    if (guess) {
      return {
        action: "confirm_interpretation",
        clarification: guess.clarification,
        topic: guess.topic,
        doNotGuess: true,
      };
    }
    return {
      action: "clarify",
      clarification: "Перепрошую, не зовсім вас зрозуміла. Можете повторити?",
      doNotGuess: true,
    };
  }

  const topic = detectTopic(text);
  if (topic && topic !== "booking") {
    return {
      action: "answer_topic",
      topic,
      preserveReservation: true,
      doNotForceBooking: true,
    };
  }

  const follow = resolveFollowUpIntent(text, state);
  if (String(follow.type).startsWith("followup")) {
    return {
      action: "answer_followup",
      ...follow,
      preserveReservation: true,
    };
  }

  if (topic === "booking" || isBookingIntent(text)) {
    return {
      action: "continue_booking",
      preserveReservation: true,
      bookingState: reservation?.status || state.bookingState,
    };
  }

  return { action: "general", preserveReservation: true };
}

export function isListenOnlyReply(text) {
  const normalized = normalizeUtterance(text);
  return (
    normalized.includes("слухаю") &&
    normalized.length < 45 &&
    !/грн|номер|брон|парков|снідан|spa|тварин/i.test(normalized)
  );
}

export function isAssistantFarewell(text) {
  const value = String(text || "");
  return (
    /до\s*побачення/i.test(value) ||
    CHATBOT_FAREWELL_PATTERNS.some((pattern) => pattern.test(value)) ||
    /гарного\s+(дня|вечора)/i.test(value)
  );
}

export function sortTranscript(transcript = []) {
  return [...transcript].sort((a, b) => {
    const ta = Date.parse(a.timestamp || 0);
    const tb = Date.parse(b.timestamp || 0);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
      return ta - tb;
    }
    return 0;
  });
}

export function looksLikeTopicJump(previousCallerText, assistantText) {
  const prev = String(previousCallerText || "").toLowerCase();
  const answer = String(assistantText || "").toLowerCase();
  if (!prev || !answer) return false;

  const askedBooking = isBookingIntent(prev);
  const answeredPets = /тварин|собак|кішк/.test(answer);
  if (askedBooking && answeredPets && !/собак|тварин/.test(prev)) return true;

  // Asking breakfast price and getting breakfast is correct, not a jump.
  if (/снідан|харчуван/.test(prev) && /снідан/.test(answer)) return false;

  const askedRoomPrice =
    /скільк|цін|кошту|вартіст/.test(prev) && /номер|делюкс|сімейн|стандарт|проживан/.test(prev);
  const answeredBreakfastOnly =
    /сніданок/.test(answer) && !/номер|стандарт|делюкс|сімейн|проживан/.test(answer);
  if (askedRoomPrice && answeredBreakfastOnly) return true;
  return false;
}

export function detectForcedBookingReturn(transcript = []) {
  const events = [];
  for (let i = 0; i < transcript.length - 1; i += 1) {
    const current = transcript[i];
    const next = transcript[i + 1];
    if (current?.speaker !== "caller" || next?.speaker !== "assistant") continue;
    const topic = detectTopic(current.text);
    if (!topic || topic === "booking") continue;
    const assistantTopic = detectTopic(next.text);
    if (
      BOOKING_FIELD_QUESTION.test(next.text) &&
      assistantTopic !== topic
    ) {
      events.push({
        callerText: current.text,
        assistantText: next.text,
        topic,
      });
    }
  }
  return events;
}

export function detectHallucinatedUnclearIntent(transcript = []) {
  const events = [];
  for (let i = 0; i < transcript.length - 1; i += 1) {
    const current = transcript[i];
    const next = transcript[i + 1];
    if (current?.speaker !== "caller" || next?.speaker !== "assistant") continue;
    if (!isUnclearSpeech(current.text)) continue;
    if (INVENTED_SERVICE_PATTERNS.some((p) => p.test(next.text))) {
      events.push({
        callerText: current.text,
        assistantText: next.text,
      });
    }
  }
  return events;
}

export function detectDuplicateBookingCompletion(transcript = []) {
  const completions = transcript.filter(
    (entry) =>
      entry.speaker === "assistant" &&
      /дані записала|підтверджую дані|тестовій версії реальне бронювання/i.test(
        entry.text
      )
  );
  return completions.length > 1 ? completions : [];
}

export function detectPrematureAssistantReplies(transcript = []) {
  let count = 0;
  for (let i = 0; i < transcript.length - 1; i += 1) {
    const current = transcript[i];
    const next = transcript[i + 1];
    if (
      current?.speaker === "caller" &&
      next?.speaker === "assistant" &&
      isIncompleteUtterance(current.text)
    ) {
      if (!isListenOnlyReply(next.text)) {
        count += 1;
      }
    }
  }
  return count;
}

export function detectPrematureFarewells(transcript = []) {
  const events = [];
  for (let i = 0; i < transcript.length; i += 1) {
    const entry = transcript[i];
    if (entry.speaker !== "assistant" || !isAssistantFarewell(entry.text)) {
      continue;
    }
    const prevCaller = [...transcript.slice(0, i)]
      .reverse()
      .find((item) => item.speaker === "caller");
    if (!prevCaller) continue;
    if (
      isSoftAcknowledgement(prevCaller.text) ||
      isGreetingUtterance(prevCaller.text) ||
      isIncompleteUtterance(prevCaller.text) ||
      !isExplicitFarewell(prevCaller.text)
    ) {
      events.push({
        callerText: prevCaller.text,
        assistantText: entry.text,
      });
    }
  }
  return events;
}

export function detectUnclearSpeechTreatedAsUnknown(transcript = []) {
  const events = [];
  for (let i = 0; i < transcript.length - 1; i += 1) {
    const current = transcript[i];
    const next = transcript[i + 1];
    if (current?.speaker !== "caller" || next?.speaker !== "assistant") continue;
    if (!isUnclearSpeech(current.text)) continue;
    if (UNKNOWN_KNOWLEDGE_PATTERNS.some((p) => p.test(next.text))) {
      events.push({
        callerText: current.text,
        assistantText: next.text,
      });
    }
  }
  return events;
}

export function detectIncorrectCheckoutWording(transcript = []) {
  return transcript.filter(
    (entry) =>
      entry.speaker === "assistant" &&
      /виїзд\s+на\s+одну\s+ніч/i.test(String(entry.text || ""))
  );
}
