const handleWebhook = require('./_webhookHandler');

module.exports = async function handler(req, res) {
  return handleWebhook('waukee', req, res);
};
