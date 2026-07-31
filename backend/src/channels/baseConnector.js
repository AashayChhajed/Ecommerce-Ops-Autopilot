/**
 * BaseChannelConnector — abstract interface for sales channel integrations.
 *
 * Each channel connector (real or mock) must implement these methods:
 *   - fetchInventory() → Array<{ channelSku, externalId, title, availableQuantity }>
 *   - updateQuantity(channelSku, quantity) → { success, newQuantity }
 *   - channelCode() → string (e.g. 'AMAZON_MOCK', 'SHOPIFY')
 *   - channelName() → string (e.g. 'Amazon (Mock)')
 *
 * Later, real connectors (Amazon SP-API, etc.) will implement this same interface
 * so the unified inventory service works unchanged.
 */
export class BaseChannelConnector {
  /** @returns {string} Unique channel code */
  channelCode() { throw new Error('Not implemented'); }

  /** @returns {string} Human-readable channel name */
  channelName() { throw new Error('Not implemented'); }

  /**
   * Fetch current inventory from the external channel.
   * @returns {Promise<Array<{channelSku: string, externalId: string|null, title: string, availableQuantity: number}>>}
   */
  async fetchInventory() { throw new Error('Not implemented'); }

  /**
   * Update a product's quantity on the external channel.
   * @param {string} channelSku
   * @param {number} quantity
   * @returns {Promise<{success: boolean, newQuantity: number}>}
   */
  async updateQuantity(channelSku, quantity) { throw new Error('Not implemented'); }
}
