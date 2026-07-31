import { BaseChannelConnector } from './baseConnector.js';
import { getMockInventory, updateMockQuantity } from './mockData.js';

/**
 * AmazonMockConnector — simulates Amazon Marketplace inventory.
 *
 * Replace this with a real Amazon SP-API (Selling Partner API) connector
 * that implements the same interface. The unified inventory service
 * works with any connector that extends BaseChannelConnector.
 */
export class AmazonMockConnector extends BaseChannelConnector {
  channelCode() { return 'AMAZON_MOCK'; }
  channelName() { return 'Amazon (Mock)'; }

  async fetchInventory() {
    // Simulate network delay
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    return getMockInventory('AMAZON_MOCK').map((item) => ({
      channelSku: item.channelSku,
      externalId: item.externalId,
      title: item.title,
      availableQuantity: item.availableQuantity,
    }));
  }

  async updateQuantity(channelSku, quantity) {
    const result = updateMockQuantity('AMAZON_MOCK', channelSku, quantity);
    return { success: result.success, newQuantity: result.item?.availableQuantity ?? quantity };
  }
}

export const amazonMockConnector = new AmazonMockConnector();
