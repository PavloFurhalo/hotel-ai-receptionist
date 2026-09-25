#!/usr/bin/env node
/**
 * Validates / seeds the file-based hotel registry.
 * Hotel configs live in /hotels (version-controlled). No SQL DB in this prototype.
 */

import {
  listHotels,
  listPhoneNumbers,
  reloadHotelRegistry,
  resolveHotelByPhone,
} from "../src/hotels/registry.js";

reloadHotelRegistry();

const hotels = listHotels({ includeInactive: true });
const phones = listPhoneNumbers();

console.log("Hotel registry OK");
console.log(`Hotels: ${hotels.length}`);
for (const hotel of hotels) {
  console.log(`  - ${hotel.id} [${hotel.status}] ${hotel.hotel?.name}`);
}
console.log(`Phone numbers: ${phones.length}`);
for (const phone of phones) {
  console.log(`  - ${phone.phoneNumber} → ${phone.hotelId} [${phone.status}]`);
}

const twilio = resolveHotelByPhone("+14066294775");
if (!twilio.ok || twilio.hotelId !== "grand-hotel-lviv") {
  console.error("Seed check failed: Twilio number must map to grand-hotel-lviv");
  process.exit(1);
}

const testB = resolveHotelByPhone("+380000000002");
if (!testB.ok || testB.hotelId !== "carpathian-resort") {
  console.error("Seed check failed: test number must map to carpathian-resort");
  process.exit(1);
}

console.log("Seed validation passed.");
