/**
 * Multi-hotel registry (file-based).
 * Phone Number → Hotel → Configuration.
 * No hardcoded if/else routing by phone digit string.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOTELS_DIR = path.resolve(__dirname, "../../hotels");

const RESERVED_FILES = new Set(["phone-numbers.json", "README.md"]);

let cache = null;

export function normalizePhoneNumber(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  return `+${digits}`;
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function buildCache(hotelsDir = HOTELS_DIR) {
  if (!existsSync(hotelsDir)) {
    throw new Error(`Hotels directory not found: ${hotelsDir}`);
  }

  const hotelsById = new Map();
  const files = readdirSync(hotelsDir).filter(
    (name) => name.endsWith(".json") && !RESERVED_FILES.has(name)
  );

  for (const file of files) {
    const data = loadJson(path.join(hotelsDir, file));
    if (!data?.id) {
      throw new Error(`Hotel config missing id: ${file}`);
    }
    hotelsById.set(data.id, data);
  }

  const phoneNumbersPath = path.join(hotelsDir, "phone-numbers.json");
  const phoneNumbers = existsSync(phoneNumbersPath)
    ? loadJson(phoneNumbersPath)
    : [];

  if (!Array.isArray(phoneNumbers)) {
    throw new Error("phone-numbers.json must be an array");
  }

  const phonesByNumber = new Map();
  for (const entry of phoneNumbers) {
    const normalized = normalizePhoneNumber(entry.phoneNumber);
    if (!normalized || !entry.hotelId) continue;
    phonesByNumber.set(normalized, {
      ...entry,
      phoneNumber: normalized,
    });
  }

  return { hotelsById, phoneNumbers, phonesByNumber, hotelsDir };
}

export function reloadHotelRegistry(hotelsDir = HOTELS_DIR) {
  cache = buildCache(hotelsDir);
  return cache;
}

function getCache() {
  if (!cache) cache = buildCache();
  return cache;
}

export function listHotels({ includeInactive = false } = {}) {
  const { hotelsById } = getCache();
  return [...hotelsById.values()].filter(
    (hotel) => includeInactive || hotel.status === "active"
  );
}

export function getHotelById(hotelId, { allowInactive = false } = {}) {
  if (!hotelId) return null;
  const hotel = getCache().hotelsById.get(hotelId) || null;
  if (!hotel) return null;
  if (!allowInactive && hotel.status !== "active") return null;
  return hotel;
}

export function listPhoneNumbers() {
  return [...getCache().phoneNumbers];
}

export function getPhoneNumberRecord(phoneNumber) {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return null;
  return getCache().phonesByNumber.get(normalized) || null;
}

/**
 * Destination hotel line for a Twilio call.
 * Inbound: guest dials hotel → hotel number is To.
 * Outbound API test: hotel number is From, guest is To.
 */
export function resolveHotelPhoneFromTwilio({
  to = null,
  from = null,
  direction = null,
} = {}) {
  const dir = String(direction || "").toLowerCase();
  if (dir.startsWith("outbound")) {
    return normalizePhoneNumber(from);
  }
  return normalizePhoneNumber(to) || normalizePhoneNumber(from);
}

export const HotelResolutionErrorCode = {
  UNKNOWN_PHONE: "unknown_phone",
  HOTEL_NOT_FOUND: "hotel_not_found",
  HOTEL_INACTIVE: "hotel_inactive",
  CONFIG_INVALID: "config_invalid",
  OVERRIDE_DENIED: "override_denied",
};

/**
 * Resolve hotel from phone number mapping.
 * Never falls back to another hotel on unknown number.
 */
export function resolveHotelByPhone(phoneNumber) {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) {
    return {
      ok: false,
      code: HotelResolutionErrorCode.UNKNOWN_PHONE,
      message: "Phone number is missing.",
    };
  }

  const phoneRecord = getPhoneNumberRecord(normalized);
  if (!phoneRecord || phoneRecord.status !== "active") {
    return {
      ok: false,
      code: HotelResolutionErrorCode.UNKNOWN_PHONE,
      message: `No active hotel mapping for ${normalized}.`,
      phoneNumber: normalized,
    };
  }

  const hotel = getCache().hotelsById.get(phoneRecord.hotelId);
  if (!hotel) {
    return {
      ok: false,
      code: HotelResolutionErrorCode.HOTEL_NOT_FOUND,
      message: `Hotel ${phoneRecord.hotelId} not found for ${normalized}.`,
      phoneNumber: normalized,
      hotelId: phoneRecord.hotelId,
    };
  }

  if (hotel.status !== "active") {
    return {
      ok: false,
      code: HotelResolutionErrorCode.HOTEL_INACTIVE,
      message: `Hotel ${hotel.id} is inactive.`,
      phoneNumber: normalized,
      hotelId: hotel.id,
    };
  }

  if (!hotel.hotel?.name || !hotel.policies) {
    return {
      ok: false,
      code: HotelResolutionErrorCode.CONFIG_INVALID,
      message: `Hotel ${hotel.id} configuration is incomplete.`,
      phoneNumber: normalized,
      hotelId: hotel.id,
    };
  }

  return {
    ok: true,
    hotel,
    hotelId: hotel.id,
    phoneNumber: normalized,
    phoneRecord,
  };
}

/**
 * Dev/test override: only when explicitly allowed.
 * Never used as production fallback for unknown numbers.
 */
export function resolveHotelByOverride(hotelId, { allowOverride = false } = {}) {
  if (!allowOverride) {
    return {
      ok: false,
      code: HotelResolutionErrorCode.OVERRIDE_DENIED,
      message: "Hotel override is disabled.",
    };
  }

  if (!hotelId) {
    return {
      ok: false,
      code: HotelResolutionErrorCode.HOTEL_NOT_FOUND,
      message: "hotelId override is empty.",
    };
  }

  const hotel = getCache().hotelsById.get(hotelId);
  if (!hotel) {
    return {
      ok: false,
      code: HotelResolutionErrorCode.HOTEL_NOT_FOUND,
      message: `Hotel ${hotelId} not found.`,
      hotelId,
    };
  }

  if (hotel.status !== "active") {
    return {
      ok: false,
      code: HotelResolutionErrorCode.HOTEL_INACTIVE,
      message: `Hotel ${hotel.id} is inactive.`,
      hotelId: hotel.id,
    };
  }

  return {
    ok: true,
    hotel,
    hotelId: hotel.id,
    phoneNumber: null,
    phoneRecord: null,
    viaOverride: true,
  };
}

/**
 * Primary call routing entry.
 * Production path: phone → hotel.
 * Optional test path: hotelId override when allowOverride=true.
 */
export function resolveHotelForCall({
  to = null,
  from = null,
  direction = null,
  hotelIdOverride = null,
  allowOverride = false,
} = {}) {
  if (hotelIdOverride) {
    return resolveHotelByOverride(hotelIdOverride, { allowOverride });
  }

  const hotelPhone = resolveHotelPhoneFromTwilio({ to, from, direction });
  return resolveHotelByPhone(hotelPhone);
}

/** Format knowledge block for system prompt (hotel-scoped). */
export function formatHotelKnowledgeForPrompt(data) {
  if (!data?.hotel) {
    throw new Error("Invalid hotel configuration for prompt.");
  }

  const rooms = Object.values(data.rooms || {})
    .map(
      (room) =>
        `- ${room.name} (${room.nameEn}): ${room.description} Макс. гостей: ${room.maxGuests}. Ціна: ${room.pricePerNight} грн за ніч. Входить: ${(room.included || []).join(", ")}.`
    )
    .join("\n");

  const amenities = Object.entries(data.amenities || {})
    .map(([key, item]) => {
      const parts = [`${key}: available=${item.available}`];
      if (item.description) parts.push(item.description);
      if (item.hours) parts.push(`hours=${item.hours}`);
      if (typeof item.price === "number") {
        parts.push(
          `price=${item.price} ${item.currency || "UAH"}${item.unit ? ` (${item.unit})` : ""}`
        );
      }
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");

  return `
HOTEL KNOWLEDGE BASE — FICTIONAL PROTOTYPE / DEMO DATA ONLY
Hotel ID: ${data.id}

Hotel:
- ${data.hotel.nameUk} / ${data.hotel.name}
- City: ${data.hotel.cityUk}
- Address: ${data.hotel.address}
- Reception: ${data.hotel.receptionHours}
- Timezone: ${data.timezone || "Europe/Kyiv"}
- Language: ${data.defaultLanguage || "uk"}

Rooms:
${rooms || "- (no room data)"}

Amenities:
${amenities || "- (no amenity data)"}

Policies:
- Check-in: ${data.policies?.checkIn}
- Check-out: ${data.policies?.checkOut}
- Early check-in: ${data.policies?.earlyCheckIn}
- Late check-out: ${data.policies?.lateCheckOut}
- Children: ${data.policies?.children}
- Pets: ${data.policies?.pets}
- Parking policy: ${data.policies?.parking}
- Cancellation: ${data.policies?.cancellation}

Prototype capabilities:
- canProvideInfo: ${data.capabilities?.canProvideInfo}
- canCreateBooking: ${data.capabilities?.canCreateBooking}
- canCancelBooking: ${data.capabilities?.canCancelBooking}
- canCheckLiveAvailability: ${data.capabilities?.canCheckLiveAvailability}
- canTransferToHuman: ${data.capabilities?.canTransferToHuman}

Topics with NO data in this prototype (say unavailable): ${(data.unknownTopics || []).join(", ")}.
`.trim();
}

export function buildSystemPrompt(hotelConfig) {
  const knowledge = formatHotelKnowledgeForPrompt(hotelConfig);
  const nameUk = hotelConfig.hotel.nameUk;

  return `
Ти — професійна адміністраторка готелю «${nameUk}».
Телефон українською. Говори тепло, живо, по-людськи — як приємна дівчина на рецепції, не як робот і не як чатбот.
Розуміння важливіше за швидкість.
Використовуй ТІЛЬКИ знання цього готелю (Hotel ID: ${hotelConfig.id}). Не змішуй з іншими готелями.

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
- Тембр: теплий, м'який, жіночий, трохи грайливий, але культурний. Не сухий і не канцелярський.
- Говори природно, з легкою посмішкою в голосі. Не поспішай і не кричи емоціями.
- Короткі backchannel («Так, звичайно.», «Зрозуміла.», «Одну хвилинку.») — лише коли доречно.
- Одну логічну відповідь — одним turn-ом. Не дроби без потреби.

ГУМОР І ЖИВА РОЗМОВА
- Якщо гість добродушно пожартував — можна коротко підхопити жарт однією фразою і одразу повернутися до справи.
- Можна м'яко підіграти настрою: «Ха, зрозуміла вас.», «Оце вже серйозний запит — давайте підберемо комфортно.»
- Без сарказму, без підколів, без образ.
- НІКОЛИ не підтримуй вульгарні, сексуальні, образливі або незаконні теми. Коротко відхили і поверни до готельних послуг.
- Не фліртуй вульгарно. Легка симпатія і тепло — так; двозначні «послуги» — ні.

СТИЛЬ
1–3 короткі живі речення. Без «звертайтеся», «якщо будуть питання», повторних пояснень.

${knowledge}
`.trim();
}
