const config = require('./src/config');
const callbacks = require('./src/callbacks');
const core = require('./src/core');
const reranker = require('./src/reranker');

module.exports = {
  ...config,
  ...callbacks,
  ...core,
  ...reranker
};