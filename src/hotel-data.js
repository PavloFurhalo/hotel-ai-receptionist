/**
 * PROTOTYPE / DEMO DATA ONLY.
 * Fictional test data for the "Carpathian Grand" voice prototype.
 * These are NOT real facts about a real hotel.
 */

export const hotelData = {
  hotel: {
    name: "Carpathian Grand",
    nameUk: "Карпатський Гранд",
    city: "Lviv",
    cityUk: "Львів",
    address: "вул. Городоцька 120, Львів, Україна",
    receptionHours: "24/7",
  },

  rooms: {
    standard: {
      name: "Стандартний",
      nameEn: "Standard",
      pricePerNight: 2500,
      currency: "UAH",
      maxGuests: 2,
      description:
        "Затишний номер з одним двоспальним ліжком, робочою зоною та видом у двір.",
      included: ["проживання", "Wi-Fi"],
    },
    deluxe: {
      name: "Делюкс",
      nameEn: "Deluxe",
      pricePerNight: 3800,
      currency: "UAH",
      maxGuests: 2,
      description:
        "Просторий номер з двоспальним ліжком, зоною відпочинку та видом на місто.",
      included: ["проживання", "Wi-Fi"],
    },
    family: {
      name: "Сімейний",
      nameEn: "Family",
      pricePerNight: 5200,
      currency: "UAH",
      maxGuests: 4,
      description:
        "Просторий номер для родини з двоспальним ліжком і двома додатковими місцями.",
      included: ["проживання", "Wi-Fi"],
    },
  },

  amenities: {
    wifi: {
      available: true,
      description: "Безкоштовний Wi-Fi у номерах і громадських зонах.",
    },
    breakfast: {
      available: true,
      description: "Сніданок оплачується окремо, не входить у вартість номера.",
      hours: "07:00–11:00",
      price: 450,
      currency: "UAH",
    },
    parking: {
      available: true,
      description: "Закрите паркування на території готелю. Місця обмежені.",
      price: 200,
      currency: "UAH",
      unit: "за добу",
    },
    restaurant: {
      available: true,
      description: "Ресторан у готелі.",
      hours: "12:00–23:00",
    },
    spa: {
      available: true,
      description: "SPA-зона в готелі.",
      hours: "10:00–22:00",
    },
  },

  policies: {
    checkIn: "14:00",
    checkOut: "12:00",
    earlyCheckIn:
      "Можливість раннього заїзду залежить від наявності; у цьому прототипі точних умов немає.",
    lateCheckOut:
      "Можливість пізнього виїзду залежить від наявності; у цьому прототипі точних умов немає.",
    children:
      "Діти до 6 років розміщуються безкоштовно без додаткового ліжка. Дитяче ліжко — 300 грн за ніч (за запитом). Для інших вікових груп у цьому прототипі окремих цін немає.",
    pets: "Домашні тварини не дозволені.",
    parking: "Паркування доступне за 200 грн на добу. Місця обмежені.",
    cancellation:
      "Безкоштовне скасування до 14:00 за день до заїзду. Пізніше — стягується вартість однієї ночі.",
  },

  capabilities: {
    canProvideInfo: true,
    canCreateBooking: false,
    canCancelBooking: false,
    canCheckLiveAvailability: false,
    canTransferToHuman: false,
  },

  /**
   * Explicitly unknown in this prototype.
   * If asked about these, say information is unavailable.
   */
  unknownTopics: [
    "більярд",
    "басейн",
    "сауна",
    "тренажерний зал",
    "трансфер",
    "пральня",
    "бар",
    "зарядка для електромобіля",
  ],
};

export function formatHotelKnowledgeForPrompt(data = hotelData) {
  const rooms = Object.values(data.rooms)
    .map(
      (room) =>
        `- ${room.name} (${room.nameEn}): ${room.description} Макс. гостей: ${room.maxGuests}. Ціна: ${room.pricePerNight} грн за ніч. Входить: ${room.included.join(", ")}.`
    )
    .join("\n");

  const amenities = Object.entries(data.amenities)
    .map(([key, item]) => {
      const parts = [`${key}: available=${item.available}`];
      if (item.description) parts.push(item.description);
      if (item.hours) parts.push(`hours=${item.hours}`);
      if (typeof item.price === "number") {
        parts.push(`price=${item.price} ${item.currency || "UAH"}${item.unit ? ` (${item.unit})` : ""}`);
      }
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");

  return `
HOTEL KNOWLEDGE BASE — FICTIONAL PROTOTYPE / DEMO DATA ONLY

Hotel:
- ${data.hotel.nameUk} / ${data.hotel.name}
- City: ${data.hotel.cityUk}
- Address: ${data.hotel.address}
- Reception: ${data.hotel.receptionHours}

Rooms:
${rooms}

Amenities:
${amenities}

Policies:
- Check-in: ${data.policies.checkIn}
- Check-out: ${data.policies.checkOut}
- Early check-in: ${data.policies.earlyCheckIn}
- Late check-out: ${data.policies.lateCheckOut}
- Children: ${data.policies.children}
- Pets: ${data.policies.pets}
- Parking policy: ${data.policies.parking}
- Cancellation: ${data.policies.cancellation}

Prototype capabilities:
- canProvideInfo: ${data.capabilities.canProvideInfo}
- canCreateBooking: ${data.capabilities.canCreateBooking}
- canCancelBooking: ${data.capabilities.canCancelBooking}
- canCheckLiveAvailability: ${data.capabilities.canCheckLiveAvailability}
- canTransferToHuman: ${data.capabilities.canTransferToHuman}

Topics with NO data in this prototype (say unavailable): ${data.unknownTopics.join(", ")}.
`.trim();
}
