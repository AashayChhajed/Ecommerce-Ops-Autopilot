import { BaseChannelConnector } from './baseConnector.js';
import { getMockInventory, updateMockQuantity } from './mockData.js';

/**
 * MyntraMockConnector — simulates Myntra marketplace inventory.
 *
 * Replace this with a real Myntra seller API connector
 * that implements the same interface.
 */
export class MyntraMockConnector extends BaseChannelConnector {
  channelCode() { return 'MYNTRA_MOCK'; }
  channelName() { return 'Myntra (Mock)'; }

  async fetchInventory() {
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 80));
    return getMockInventory('MYNTRA_MOCK').map((item) => ({
      channelSku: item.channelSku,
      externalId: item.externalId,
      title: item.title,
      availableQuantity: item.availableQuantity,
    }));
  }

  async updateQuantity(channelSku, quantity) {
    const result = updateMockQuantity('MYNTRA_MOCK', channelSku, quantity);
    return { success: result.success, newQuantity: result.item?.availableQuantity ?? quantity };
  }
}

export const myntraMockConnector = new MyntraMockConnector();
