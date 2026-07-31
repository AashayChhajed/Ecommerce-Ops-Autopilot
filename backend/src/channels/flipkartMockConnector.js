import { BaseChannelConnector } from './baseConnector.js';
import { getMockInventory, updateMockQuantity } from './mockData.js';

/**
 * FlipkartMockConnector — simulates Flipkart marketplace inventory.
 *
 * Replace this with a real Flipkart Seller API connector
 * that implements the same interface.
 */
export class FlipkartMockConnector extends BaseChannelConnector {
  channelCode() { return 'FLIPKART_MOCK'; }
  channelName() { return 'Flipkart (Mock)'; }

  async fetchInventory() {
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 90));
    return getMockInventory('FLIPKART_MOCK').map((item) => ({
      channelSku: item.channelSku,
      externalId: item.externalId,
      title: item.title,
      availableQuantity: item.availableQuantity,
    }));
  }

  async updateQuantity(channelSku, quantity) {
    const result = updateMockQuantity('FLIPKART_MOCK', channelSku, quantity);
    return { success: result.success, newQuantity: result.item?.availableQuantity ?? quantity };
  }
}

export const flipkartMockConnector = new FlipkartMockConnector();
