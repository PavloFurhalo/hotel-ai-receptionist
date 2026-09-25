/**
 * Backward-compatible hotel-data facade.
 * Canonical multi-hotel configs live in /hotels/*.json via registry.
 */

import {
  formatHotelKnowledgeForPrompt,
  getHotelById,
  listHotels,
} from "./hotels/registry.js";

/** @deprecated Use getHotelById / listHotels from hotels/registry.js */
export const hotelData = getHotelById("grand-hotel-lviv");

export { formatHotelKnowledgeForPrompt, getHotelById, listHotels };
