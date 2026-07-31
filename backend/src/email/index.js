export {
  sendEmail,
  sendOrderNotification,
  sendLowStockAlert,
  resetTransporter,
} from './emailService.js';

export {
  buildOrderEmailHtml,
  buildOrderEmailPlainText,
  buildLowStockAlertHtml,
  buildLowStockAlertPlainText,
} from './emailTemplates.js';
