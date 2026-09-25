import { hotelData } from "./hotel-data.js";
import {
  detectDuplicateBookingCompletion,
  detectForcedBookingReturn,
  detectHallucinatedUnclearIntent,
  detectIncorrectCheckoutWording,
  detectPrematureAssistantReplies,
  detectPrematureFarewells,
  detectUnclearSpeechTreatedAsUnknown,
  hasConfirmationAndNewQuestion,
  isBookingIntent,
  isExplicitFarewell,
  looksLikeTopicJump,
} from "./conversation.js";
import { getMissingReservationFields } from "./reservation.js";

/**
 * Deterministic post-call QA (no LLM).
 * evaluator id bumped for V1.2 failure modes.
 */
export function buildCallQa({
  transcript = [],
  reservationDraft = null,
  metadata = {},
  errors = [],
  hotelConfig = null,
} = {}) {
  const hotel = hotelConfig || hotelData;
  const interruptions = metadata.interruptions || 0;
  const prematureResponses = detectPrematureAssistantReplies(transcript);
  const prematureFarewells = detectPrematureFarewells(transcript);
  const unclearAsUnknown = detectUnclearSpeechTreatedAsUnknown(transcript);
  const incorrectCheckout = detectIncorrectCheckoutWording(transcript);
  const forcedBookingReturn = detectForcedBookingReturn(transcript);
  const unclearHallucinations = detectHallucinatedUnclearIntent(transcript);
  const duplicateCompletions = detectDuplicateBookingCompletion(transcript);

  const issues = [];
  const strengths = [];
  const transcriptionIssues = [];

  let contextErrors = 0;
  let contextMiss = 0;
  let hallucinations = 0;
  let bookingErrors = 0;
  let unansweredQuestions = 0;
  let repeatedQuestions = 0;
  let bookingFieldRegression = 0;
  let postConfirmationPrematureEnd = 0;
  let unnecessaryFarewell = prematureFarewells.length;
  let prematureFarewell = prematureFarewells.length;
  let ambiguousSpeechHandledAsUnknownKnowledge = unclearAsUnknown.length;
  let incorrectCheckoutWording = incorrectCheckout.length;
  let forcedBookingReturnCount = forcedBookingReturn.length;
  let unclearSpeechHallucinatedIntent = unclearHallucinations.length;
  let duplicateBookingCompletion = duplicateCompletions.length;
  let confirmationPlusQuestionIgnored = 0;

  const knownPrices = Object.values(hotel.rooms || {}).map((r) => r.pricePerNight);
  const pricePattern = /(\d{3,5})\s*(грн|гривень|гривні)/gi;

  for (let i = 0; i < transcript.length; i += 1) {
    const entry = transcript[i];
    if (entry.speaker === "assistant") {
      const matches = [...String(entry.text).matchAll(pricePattern)];
      for (const match of matches) {
        const price = Number(match[1]);
        if (
          !knownPrices.includes(price) &&
          price !== hotel.amenities?.breakfast?.price &&
          price !== hotel.amenities?.parking?.price
        ) {
          hallucinations += 1;
          issues.push(`Possible invented price in assistant reply: ${price}`);
        }
      }

      if (/бронюванн.*(створен|оформлен)/i.test(entry.text)) {
        if (!reservationDraft || reservationDraft.status !== "confirmed_for_test") {
          bookingErrors += 1;
          issues.push("Assistant implied a real booking was created.");
        }
      }

      const prevCaller = [...transcript.slice(0, i)]
        .reverse()
        .find((item) => item.speaker === "caller");
      if (prevCaller && looksLikeTopicJump(prevCaller.text, entry.text)) {
        contextErrors += 1;
        contextMiss += 1;
        issues.push(
          `Possible context jump after caller said: "${prevCaller.text}"`
        );
      }
    }

    if (entry.speaker === "caller") {
      const text = String(entry.text || "");
      if (hasConfirmationAndNewQuestion(text)) {
        const nextAssistant = transcript
          .slice(i + 1)
          .find((item) => item.speaker === "assistant");
        if (
          nextAssistant &&
          /дані записала|підтверджую дані/i.test(nextAssistant.text) &&
          !/грн|кошту|цін|снідан|spa|парков/i.test(nextAssistant.text)
        ) {
          confirmationPlusQuestionIgnored += 1;
          issues.push("Confirmation+question turn ignored the new question.");
        }
      }
      if (/[?]/.test(text) || /скільк|чи є|підкаж|розкаж/i.test(text)) {
        const nextAssistant = transcript
          .slice(i + 1)
          .find((item) => item.speaker === "assistant");
        if (!nextAssistant) unansweredQuestions += 1;
      }

      if (/^[A-Za-z]{1,4}$/.test(text.trim()) || /ashgabat|ашхабад|спалховик/i.test(text)) {
        transcriptionIssues.push(text);
      }
    }
  }

  // Repeated question: assistant asks for a field already present in draft.
  if (reservationDraft) {
    const askedAgain = transcript.filter(
      (entry) =>
        entry.speaker === "assistant" &&
        ((reservationDraft.guests && /скільки\s+(буде\s+)?гост/i.test(entry.text)) ||
          (reservationDraft.roomType && /який\s+номер/i.test(entry.text)) ||
          (reservationDraft.guestName && /на\s+яке\s+ім/i.test(entry.text)) ||
          (reservationDraft.checkIn && /на\s+яку\s+дату.*заїзд/i.test(entry.text)))
    );
    repeatedQuestions = askedAgain.length;
    if (repeatedQuestions > 0) {
      issues.push(`Possible repeated booking questions: ${repeatedQuestions}`);
    }

    const missing = getMissingReservationFields(reservationDraft);
    if (reservationDraft.status === "confirmed_for_test" && missing.length > 0) {
      bookingErrors += 1;
      bookingFieldRegression += missing.length;
      issues.push(`Confirmed draft is missing fields: ${missing.join(", ")}`);
    }
    if (
      reservationDraft.status === "confirmed_for_test" &&
      missing.length === 0
    ) {
      strengths.push("Reservation draft fully collected and confirmed for test.");
    }
  }

  // After confirmed_for_test wording, farewell without explicit caller goodbye.
  for (let i = 0; i < transcript.length; i += 1) {
    const entry = transcript[i];
    if (
      entry.speaker === "assistant" &&
      /дані записала|тестовій версії реальне бронювання/i.test(entry.text)
    ) {
      const later = transcript.slice(i + 1);
      const laterFarewell = later.find(
        (item) => item.speaker === "assistant" && /до\s*побачення|гарного\s+(дня|вечора)/i.test(item.text)
      );
      const callerFarewell = later.find(
        (item) => item.speaker === "caller" && isExplicitFarewell(item.text)
      );
      const followUp = later.find(
        (item) =>
          item.speaker === "caller" &&
          /парков|снідан|spa|спа|тварин|собак/i.test(item.text)
      );
      if (laterFarewell && !callerFarewell) {
        postConfirmationPrematureEnd += 1;
        issues.push("Premature end after booking confirmation.");
      }
      if (followUp) {
        strengths.push("Conversation continued after booking confirmation.");
      }
    }
  }

  if (prematureFarewells.length > 0) {
    issues.push(`Premature/unnecessary farewells: ${prematureFarewells.length}`);
  }
  if (unclearAsUnknown.length > 0) {
    issues.push(
      `Unclear speech treated as unknown knowledge: ${unclearAsUnknown.length}`
    );
  }
  if (incorrectCheckout.length > 0) {
    issues.push(`Incorrect checkout wording: ${incorrectCheckout.length}`);
  }
  if (forcedBookingReturn.length > 0) {
    issues.push(`Forced booking return over new topic: ${forcedBookingReturn.length}`);
  }
  if (unclearHallucinations.length > 0) {
    issues.push(`Unclear speech answered with invented intent: ${unclearHallucinations.length}`);
  }
  if (duplicateCompletions.length > 1) {
    issues.push("Duplicate booking completion responses.");
  }

  if (prematureResponses === 0) {
    strengths.push("No clear premature replies to incomplete fragments.");
  } else {
    issues.push(
      `Premature responses to short/incomplete utterances: ${prematureResponses}`
    );
  }

  if (interruptions <= 2) {
    strengths.push("Interruptions stayed relatively low.");
  } else {
    issues.push(`High interruption count: ${interruptions}`);
  }

  const hadFarewell = transcript.some(
    (entry) => entry.speaker === "caller" && isExplicitFarewell(entry.text)
  );
  if (hadFarewell) strengths.push("Caller used an explicit farewell.");

  if (errors.length > 0) {
    issues.push(`Call had ${errors.length} runtime error(s).`);
  }

  if (
    reservationDraft?.status === "collecting" &&
    isBookingIntent(
      [...transcript].reverse().find((t) => t.speaker === "caller")?.text || ""
    )
  ) {
    strengths.push("Booking flow started and draft was persisted.");
  }

  let overallScore = 100;
  overallScore -= prematureResponses * 8;
  overallScore -= contextErrors * 15;
  overallScore -= hallucinations * 12;
  overallScore -= bookingErrors * 15;
  overallScore -= unansweredQuestions * 5;
  overallScore -= prematureFarewell * 12;
  overallScore -= ambiguousSpeechHandledAsUnknownKnowledge * 10;
  overallScore -= repeatedQuestions * 6;
  overallScore -= bookingFieldRegression * 8;
  overallScore -= postConfirmationPrematureEnd * 12;
  overallScore -= incorrectCheckoutWording * 8;
  overallScore -= forcedBookingReturnCount * 12;
  overallScore -= unclearSpeechHallucinatedIntent * 12;
  overallScore -= duplicateBookingCompletion > 1 ? 8 : 0;
  overallScore -= confirmationPlusQuestionIgnored * 10;
  overallScore -= Math.min(interruptions, 10) * 2;
  overallScore -= errors.length * 10;
  overallScore = Math.max(0, Math.min(100, overallScore));

  const summaryParts = [`Score ${overallScore}/100.`];
  if (issues.length === 0) {
    summaryParts.push("No major deterministic QA issues detected.");
  } else {
    summaryParts.push(`Issues: ${issues.slice(0, 3).join(" | ")}`);
  }

  return {
    overallScore,
    transcriptionIssues,
    prematureResponses,
    contextErrors,
    contextMiss,
    hallucinations,
    bookingErrors,
    unansweredQuestions,
    interruptions,
    premature_farewell: prematureFarewell,
    unnecessary_farewell: unnecessaryFarewell,
    ambiguous_speech_handled_as_unknown_knowledge:
      ambiguousSpeechHandledAsUnknownKnowledge,
    repeated_question: repeatedQuestions,
    booking_field_regression: bookingFieldRegression,
    post_confirmation_premature_end: postConfirmationPrematureEnd,
    incorrect_checkout_wording: incorrectCheckoutWording,
    forced_booking_return: forcedBookingReturnCount,
    unclear_speech_hallucinated_intent: unclearSpeechHallucinatedIntent,
    duplicate_booking_completion: duplicateBookingCompletion,
    confirmation_plus_question_ignored: confirmationPlusQuestionIgnored,
    strengths,
    issues,
    summary: summaryParts.join(" "),
    evaluator: "deterministic-v1.2",
  };
}
