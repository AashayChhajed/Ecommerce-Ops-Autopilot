import { amazonMockConnector } from './amazonMockConnector.js';
import { myntraMockConnector } from './myntraMockConnector.js';
import { flipkartMockConnector } from './flipkartMockConnector.js';
import { BaseChannelConnector } from './baseConnector.js';
import {
  initializeMockData,
  getMockInventory,
  updateMockQuantity,
  updateMockQuantityByProductId,
} from './mockData.js';

/** Map of channel code → connector instance */
export const channelConnectors = {
  AMAZON_MOCK: amazonMockConnector,
  MYNTRA_MOCK: myntraMockConnector,
  FLIPKART_MOCK: flipkartMockConnector,
};

/** All mock channel codes */
export const MOCK_CHANNEL_CODES = ['AMAZON_MOCK', 'MYNTRA_MOCK', 'FLIPKART_MOCK'];

/** All channel codes (including Shopify) */
export const ALL_CHANNEL_CODES = ['SHOPIFY', ...MOCK_CHANNEL_CODES];

export {
  BaseChannelConnector,
  initializeMockData,
  getMockInventory,
  updateMockQuantity,
  updateMockQuantityByProductId,
};
