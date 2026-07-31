/**
 * MockChannelDataStore — in-memory mock data for Amazon, Myntra, and Flipkart.
 *
 * This replaces real API calls during development/demo.
 * Quantities can be edited at runtime for testing overselling scenarios.
 *
 * To replace with a real connector later:
 *   1. Implement the same BaseChannelConnector interface
 *   2. Replace the mock endpoints in server.js with real API calls
 *   3. Remove or keep this file for fallback/testing
 */

const mockStore = {
  AMAZON_MOCK: [],
  MYNTRA_MOCK: [],
  FLIPKART_MOCK: [],
};

let initialized = false;

/**
 * Reset and reload the mock store from seed data.
 * Called once at startup, can be re-called for testing.
 */
export function initializeMockData(seedDataByChannel) {
  for (const [channel, products] of Object.entries(seedDataByChannel)) {
    mockStore[channel] = products.map((p, idx) => ({
      id: idx + 1,
      channelSku: p.channelSku,
      externalId: p.externalId || null,
      title: p.title,
      availableQuantity: p.availableQuantity,
      internalProductId: p.internalProductId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }
  initialized = true;
}

export function isInitialized() {
  return initialized;
}

/**
 * Get mock inventory for a specific channel.
 * @param {'AMAZON_MOCK' | 'MYNTRA_MOCK' | 'FLIPKART_MOCK'} channelCode
 * @returns {Array}
 */
export function getMockInventory(channelCode) {
  return [...(mockStore[channelCode] || [])];
}

/**
 * Update quantity for a specific product on a mock channel.
 * @param {'AMAZON_MOCK' | 'MYNTRA_MOCK' | 'FLIPKART_MOCK'} channelCode
 * @param {string} channelSku
 * @param {number} newQuantity
 * @returns {{ success: boolean, item: object | null }}
 */
export function updateMockQuantity(channelCode, channelSku, newQuantity) {
  const items = mockStore[channelCode];
  if (!items) return { success: false, item: null };

  const idx = items.findIndex((i) => i.channelSku === channelSku);
  if (idx === -1) return { success: false, item: null };

  items[idx].availableQuantity = Math.max(0, Math.floor(newQuantity));
  items[idx].updatedAt = new Date().toISOString();
  return { success: true, item: { ...items[idx] } };
}

/**
 * Update quantity for a specific product on a mock channel by internal product ID.
 * @param {'AMAZON_MOCK' | 'MYNTRA_MOCK' | 'FLIPKART_MOCK'} channelCode
 * @param {number} internalProductId
 * @param {number} newQuantity
 * @returns {{ success: boolean, item: object | null }}
 */
export function updateMockQuantityByProductId(channelCode, internalProductId, newQuantity) {
  const items = mockStore[channelCode];
  if (!items) return { success: false, item: null };

  const idx = items.findIndex((i) => i.internalProductId === internalProductId);
  if (idx === -1) return { success: false, item: null };

  items[idx].availableQuantity = Math.max(0, Math.floor(newQuantity));
  items[idx].updatedAt = new Date().toISOString();
  return { success: true, item: { ...items[idx] } };
}

export default mockStore;
