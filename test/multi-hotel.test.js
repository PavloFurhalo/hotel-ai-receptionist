import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  getHotelById,
  listHotels,
  listPhoneNumbers,
  normalizePhoneNumber,
  reloadHotelRegistry,
  resolveHotelByPhone,
  resolveHotelForCall,
  resolveHotelPhoneFromTwilio,
  HotelResolutionErrorCode,
} from "../src/hotels/registry.js";
import { createReceptionistAgent, realtimeSessionConfig } from "../src/agent.js";
import {
  createCallLog,
  finishCall,
} from "../src/call-logger.js";

reloadHotelRegistry();

const HOTEL_A = "grand-hotel-lviv";
const HOTEL_B = "carpathian-resort";
const PHONE_A = "+14066294775";
const PHONE_B = "+380000000002";
const PHONE_INACTIVE = "+380000000099";
const PHONE_UNKNOWN = "+380111111111";

test("TEST 1: Phone A → Hotel A", () => {
  const result = resolveHotelByPhone(PHONE_A);
  assert.equal(result.ok, true);
  assert.equal(result.hotelId, HOTEL_A);
  assert.equal(result.hotel.hotel.name, "Grand Hotel Lviv");
});

test("TEST 2: Phone B → Hotel B", () => {
  const result = resolveHotelByPhone(PHONE_B);
  assert.equal(result.ok, true);
  assert.equal(result.hotelId, HOTEL_B);
  assert.equal(result.hotel.hotel.name, "Carpathian Resort");
});

test("TEST 3: Phone A → prompt Hotel A", () => {
  const hotel = getHotelById(HOTEL_A);
  const prompt = buildSystemPrompt(hotel);
  assert.match(prompt, /Гранд Готель Львів/);
  assert.match(prompt, /14:00/);
  assert.match(prompt, /08:00–11:00/);
  assert.doesNotMatch(prompt, /Карпатський Резорт/);
  assert.doesNotMatch(prompt, /Яремче/);
});

test("TEST 4: Phone B → prompt Hotel B", () => {
  const hotel = getHotelById(HOTEL_B);
  const prompt = buildSystemPrompt(hotel);
  assert.match(prompt, /Карпатський Резорт/);
  assert.match(prompt, /15:00/);
  assert.match(prompt, /07:30–10:30/);
  assert.match(prompt, /SPA-зона/);
  assert.doesNotMatch(prompt, /Гранд Готель Львів/);
  assert.doesNotMatch(prompt, /просп\. Свободи 13/);
});

test("TEST 5: Hotel A does not receive Hotel B data", () => {
  const hotelA = getHotelById(HOTEL_A);
  const promptA = buildSystemPrompt(hotelA);
  assert.equal(hotelA.amenities.spa, undefined);
  assert.doesNotMatch(promptA, /Carpathian Resort/);
  assert.doesNotMatch(promptA, /Яремче/);
  assert.doesNotMatch(promptA, /07:30–10:30/);
  assert.equal(hotelA.policies.checkIn, "14:00");
  assert.notEqual(hotelA.policies.checkIn, getHotelById(HOTEL_B).policies.checkIn);
});

test("TEST 6: Hotel B does not receive Hotel A data", () => {
  const hotelB = getHotelById(HOTEL_B);
  const promptB = buildSystemPrompt(hotelB);
  assert.doesNotMatch(promptB, /Grand Hotel Lviv/);
  assert.doesNotMatch(promptB, /просп\. Свободи 13/);
  assert.doesNotMatch(promptB, /08:00–11:00/);
  assert.equal(hotelB.policies.checkOut, "11:00");
  assert.ok(hotelB.amenities.spa?.available);
});

test("TEST 7: Unknown phone → controlled error, no hotel fallback", () => {
  const result = resolveHotelByPhone(PHONE_UNKNOWN);
  assert.equal(result.ok, false);
  assert.equal(result.code, HotelResolutionErrorCode.UNKNOWN_PHONE);
  assert.equal(result.hotel, undefined);
  assert.equal(result.hotelId, undefined);
});

test("TEST 8: Inactive hotel → controlled error", () => {
  const result = resolveHotelByPhone(PHONE_INACTIVE);
  assert.equal(result.ok, false);
  assert.equal(result.code, HotelResolutionErrorCode.HOTEL_INACTIVE);
  assert.equal(result.hotelId, "inactive-demo-hotel");
});

test("TEST 9: Existing Twilio outbound call resolves Hotel A (voice pipeline unchanged)", () => {
  // Current outbound test: From=Twilio hotel line, To=guest.
  const hotelPhone = resolveHotelPhoneFromTwilio({
    to: "+380677486490",
    from: PHONE_A,
    direction: "outbound-api",
  });
  assert.equal(hotelPhone, PHONE_A);

  const result = resolveHotelForCall({
    to: "+380677486490",
    from: PHONE_A,
    direction: "outbound-api",
  });
  assert.equal(result.ok, true);
  assert.equal(result.hotelId, HOTEL_A);

  const agent = createReceptionistAgent(result.hotel);
  assert.match(agent.name, /Grand Hotel Lviv/);
  assert.equal(realtimeSessionConfig.model, "gpt-realtime");
  assert.equal(
    realtimeSessionConfig.config.audio.input.turnDetection.type,
    "semantic_vad"
  );
});

test("TEST 10: Call log contains correct hotel_id", async () => {
  const call = createCallLog({
    callSid: "CA_MULTI_HOTEL_UNIT",
    from: PHONE_A,
    to: "+380677486490",
    direction: "outbound-api",
    hotelId: HOTEL_A,
    hotelPhone: PHONE_A,
    metadata: {
      hotelConfig: getHotelById(HOTEL_A),
    },
    silent: true,
  });

  const saved = await finishCall(call);
  assert.equal(saved.hotelId, HOTEL_A);
  assert.equal(saved.hotelPhone, PHONE_A);
  assert.equal(saved.metadata.hotelId, HOTEL_A);
});

test("phone mapping is data-driven (no hardcoded if/else by number in registry)", () => {
  const phones = listPhoneNumbers();
  assert.ok(phones.some((p) => p.phoneNumber === PHONE_A && p.hotelId === HOTEL_A));
  assert.ok(phones.some((p) => p.phoneNumber === PHONE_B && p.hotelId === HOTEL_B));
  assert.equal(normalizePhoneNumber("14066294775"), PHONE_A);
});

test("dev override works only when allowOverride=true", () => {
  const denied = resolveHotelForCall({
    hotelIdOverride: HOTEL_B,
    allowOverride: false,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, HotelResolutionErrorCode.OVERRIDE_DENIED);

  const allowed = resolveHotelForCall({
    hotelIdOverride: HOTEL_B,
    allowOverride: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.hotelId, HOTEL_B);
  assert.equal(allowed.viaOverride, true);
});

test("two active hotels are seeded", () => {
  const hotels = listHotels();
  const ids = hotels.map((h) => h.id);
  assert.ok(ids.includes(HOTEL_A));
  assert.ok(ids.includes(HOTEL_B));
  assert.ok(!ids.includes("inactive-demo-hotel"));
});

test("agents for A and B have isolated instructions", () => {
  const agentA = createReceptionistAgent(getHotelById(HOTEL_A));
  const agentB = createReceptionistAgent(getHotelById(HOTEL_B));
  assert.match(agentA.instructions, /Гранд Готель Львів/);
  assert.match(agentB.instructions, /Карпатський Резорт/);
  assert.doesNotMatch(agentA.instructions, /Карпатський Резорт/);
  assert.doesNotMatch(agentB.instructions, /Гранд Готель Львів/);
});
