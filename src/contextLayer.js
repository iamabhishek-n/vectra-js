const { getEncoding } = require('js-tiktoken');

let _tokenEncoder = null;
function _getTokenEncoder() {
  if (!_tokenEncoder) _tokenEncoder = getEncoding('cl100k_base');
  return _tokenEncoder;
}

function _encodeForTest(text) {
  return _getTokenEncoder().encode(String(text));
}

const _tokenCache = new Map();

function estimateTokensCached(text) {
  if (!text) return 0;
  const key = String(text);
  if (_tokenCache.has(key)) return _tokenCache.get(key);
  const count = _encodeForTest(key).length;
  _tokenCache.set(key, count);
  return count;
}

function _clearTokenCache() {
  _tokenCache.clear();
}

module.exports = { estimateTokensCached, _clearTokenCache, _encodeForTest };
