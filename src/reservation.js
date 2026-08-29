/**
 * Prototype reservation draft helpers.
 * No real PMS/booking backend — structured data collection only.
 */

export const RESERVATION_STATUSES = [
  "idle",
  "collecting",
  "awaiting_confirmation",
  "confirmed_for_test",
];

export const ROOM_TYPES = ["standard", "deluxe", "family"];

/**
 * checkOut OR nights satisfies the stay-length requirement.
 */
export const REQUIRED_RESERVATION_FIELDS = [
  "checkIn",
  "stayLength",
  "guests",
  "roomType",
  "guestName",
];

export function createEmptyReservationDraft({ phone = null } = {}) {
  return {
    checkIn: null,
    checkOut: null,
    nights: null,
    guests: null,
    roomType: null,
    guestName: null,
    phone: phone || null,
    status: "collecting",
  };
}

/**
 * Merge only explicitly provided non-empty fields.
 * Latest explicit value wins (supports corrections).
 * Never invent dates/guests/names.
 */
export function applyReservationDraftUpdate(draft, patch = {}) {
  const next = draft ? { ...draft } : createEmptyReservationDraft();

  for (const key of [
    "checkIn",
    "checkOut",
    "nights",
    "guests",
    "roomType",
    "guestName",
    "phone",
    "status",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === "") continue;
    next[key] = value;
  }

  if (!RESERVATION_STATUSES.includes(next.status)) {
    next.status = "collecting";
  }

  if (next.status === "idle") {
    next.status = "collecting";
  }

  if (next.roomType && !ROOM_TYPES.includes(next.roomType)) {
    next.roomType = null;
  }

  if (typeof next.nights === "number" && next.nights <= 0) {
    next.nights = null;
  }

  return next;
}

export function getMissingReservationFields(draft) {
  if (!draft) return [...REQUIRED_RESERVATION_FIELDS];
  const missing = [];
  if (!draft.checkIn) missing.push("checkIn");
  if (!draft.checkOut && !draft.nights) missing.push("checkOutOrNights");
  if (!draft.guests) missing.push("guests");
  if (!draft.roomType) missing.push("roomType");
  if (!draft.guestName) missing.push("guestName");
  return missing;
}

export function getNextMissingField(draft) {
  const missing = getMissingReservationFields(draft);
  return missing[0] || null;
}

export function isReservationReadyForConfirmation(draft) {
  return getMissingReservationFields(draft).length === 0;
}

export function hasAnyReservationData(draft) {
  if (!draft) return false;
  return Boolean(
    draft.checkIn ||
      draft.checkOut ||
      draft.nights ||
      draft.guests ||
      draft.roomType ||
      draft.guestName ||
      draft.phone ||
      draft.status === "awaiting_confirmation" ||
      draft.status === "confirmed_for_test"
  );
}

/**
 * Extract multiple booking fields from one Ukrainian sentence when unambiguous.
 */
export function extractReservationFieldsFromText(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const patch = {};

  if (/сімейн/.test(lower)) patch.roomType = "family";
  else if (/делюкс|deluxe/.test(lower)) patch.roomType = "deluxe";
  else if (/стандарт/.test(lower)) patch.roomType = "standard";

  const guestWord =
    lower.match(
      /(?:на\s+)?(\d+)\s*(?:особ|люд|гост)|нас\s+буде\s+(\d+)|нас\s+(\d+)|на\s+(двох|трьох|чотирьох)|двоє|троє|четверо/
    ) || null;

  if (/на\s+двох|двоє|двое/.test(lower)) patch.guests = 2;
  else if (/на\s+трьох|троє/.test(lower)) patch.guests = 3;
  else if (/на\s+чотирьох|четверо/.test(lower)) patch.guests = 4;
  else if (guestWord) {
    const num = Number(guestWord[1] || guestWord[2] || guestWord[3]);
    if (Number.isFinite(num) && num > 0) patch.guests = num;
  }

  const nightsMatch = lower.match(/на\s+(\d+)\s*ніч|на\s+одну\s+ніч|одну\s+ніч/);
  if (/на\s+одну\s+ніч|одну\s+ніч/.test(lower)) patch.nights = 1;
  else if (nightsMatch?.[1]) patch.nights = Number(nightsMatch[1]);

  const numericRange = raw.match(
    /(?:на|з)\s+(\d{1,2})\s+по\s+(\d{1,2})(?:\s+([а-яіїєґ]+))?/i
  );
  if (numericRange) {
    const month = numericRange[3] ? ` ${numericRange[3]}` : "";
    patch.checkIn = `${numericRange[1]}${month}`.trim();
    patch.checkOut = `${numericRange[2]}${month}`.trim();
  }

  const checkoutFix = raw.match(/виїзд\s+(\d{1,2})(?:-го)?(?:\s+([а-яіїєґ]+))?/i);
  if (checkoutFix) {
    patch.checkOut = `${checkoutFix[1]}${checkoutFix[2] ? ` ${checkoutFix[2]}` : ""}`.trim();
  }

  const namedGuest = raw.match(/мене\s+звати\s+([A-Za-zА-ЯІЇЄҐа-яіїєґ'ʼ-]+)/i);
  if (namedGuest) {
    patch.guestName = namedGuest[1];
  }

  // "з п'ятниці до суботи" / "у п'ятницю"
  const range = raw.match(
    /з\s+([^,]+?)\s+до\s+([^,.]+)/i
  );
  if (range && !numericRange) {
    patch.checkIn = range[1].trim();
    patch.checkOut = range[2].trim();
  } else if (!numericRange) {
    const friday = raw.match(
      /(?:з|у|на)\s+(наступн\w+\s+)?(п['ʼ]ятниц\w+|понеділок\w*|вівтор\w*|серед\w*|четвер\w*|субот\w*|неділ\w*|завтра|післязавтра)/i
    );
    if (friday) {
      patch.checkIn = `${friday[1] || ""}${friday[2]}`.trim();
    }
  }

  const nameMatch = raw.match(
    /на\s+(?:ім['ʼ]я\s+)?([А-ЯІЇЄҐ][а-яіїєґ'ʼ-]{2,})(?!\s+ніч)/
  );
  if (nameMatch) {
    const candidate = nameMatch[1];
    if (
      !/п['ʼ]ятниц|понеділ|вівтор|серед|четвер|субот|неділ|стандарт|сімейн|делюкс/i.test(
        candidate
      )
    ) {
      patch.guestName = candidate;
    }
  }

  return patch;
}

export function serializeReservationDraft(draft) {
  if (!hasAnyReservationData(draft)) return null;
  return {
    checkIn: draft.checkIn ?? null,
    checkOut: draft.checkOut ?? null,
    nights: draft.nights ?? null,
    guests: draft.guests ?? null,
    roomType: draft.roomType ?? null,
    guestName: draft.guestName ?? null,
    phone: draft.phone ?? null,
    status: draft.status ?? "collecting",
    missingFields: getMissingReservationFields(draft),
  };
}

/**
 * Detect if a later draft regresses a previously known field unexpectedly.
 * Corrections are allowed; regressions to null are flagged.
 */
export function detectBookingFieldRegression(previousDraft, nextDraft) {
  if (!previousDraft || !nextDraft) return [];
  const regressions = [];
  for (const field of [
    "checkIn",
    "checkOut",
    "nights",
    "guests",
    "roomType",
    "guestName",
    "phone",
  ]) {
    const prev = previousDraft[field];
    const next = nextDraft[field];
    if (prev !== null && prev !== undefined && prev !== "" && (next === null || next === undefined || next === "")) {
      regressions.push(field);
    }
  }
  return regressions;
}
