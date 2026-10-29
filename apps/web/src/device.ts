// What the device can afford. Chrome reports approximate RAM in GB
// (navigator.deviceMemory: 0.25 to 8); other browsers report nothing and
// are treated as ordinary devices.
const memory = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

/** Phones with 2 GB of RAM or less. */
export const lowMemory = memory !== undefined && memory <= 2;

/** Most pixels in one rendered page: a decoded page costs 4 bytes per pixel. */
export const PAGE_PIXEL_BUDGET = lowMemory ? 4_000_000 : memory !== undefined && memory <= 4 ? 8_000_000 : 16_000_000;

/** Rendered pages kept for quick scrolling back. */
export const PAGE_CACHE_SIZE = lowMemory ? 6 : 14;
