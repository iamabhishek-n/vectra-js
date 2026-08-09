const { getEncoding } = require('js-tiktoken');

let _tokenEncoder = null;
function _getTokenEncoder() {
  if (!_tokenEncoder) _tokenEncoder = getEncoding('cl100k_base');
  return _tokenEncoder;
}

function _encodeForTest(text) {
  return _getTokenEncoder().encode(String(text));
}

// Bounded, LRU-evicted — matches the existing LRUCache convention already used for
// the embedding cache in core.js (self-contained here rather than shared, to avoid
// a circular require between contextLayer.js and core.js: core.js requires this
// module for buildContext).
const TOKEN_CACHE_MAX_SIZE = 10000;
const _tokenCache = new Map();

function estimateTokensCached(text) {
  if (!text) return 0;
  const key = String(text);
  if (_tokenCache.has(key)) {
    const count = _tokenCache.get(key);
    _tokenCache.delete(key);
    _tokenCache.set(key, count); // refresh recency
    return count;
  }
  // Called via module.exports (not the closure-local reference) so tests can
  // jest.spyOn the exported symbol and actually observe internal calls — a plain
  // closure call is invisible to spyOn on the export, a real gap found in self-review.
  const count = module.exports._encodeForTest(key).length;
  _tokenCache.set(key, count);
  if (_tokenCache.size > TOKEN_CACHE_MAX_SIZE) {
    const oldestKey = _tokenCache.keys().next().value;
    _tokenCache.delete(oldestKey);
  }
  return count;
}

function _clearTokenCache() {
  _tokenCache.clear();
}

function _reciprocalRankFusion(resultLists, k = 60) {
  const scores = {};
  const contentMap = {};
  resultLists.forEach(list => {
    list.forEach((doc, rank) => {
      if (!contentMap[doc.content]) contentMap[doc.content] = doc;
      if (!scores[doc.content]) scores[doc.content] = 0;
      scores[doc.content] += 1 / (k + rank + 1);
    });
  });
  return Object.keys(scores)
    .sort((a, b) => scores[b] - scores[a])
    .map(content => contentMap[content]);
}

async function buildContext(input) {
  const { query, budget = {}, sources = [], priority } = input;
  const maxTokens = budget.maxTokens ?? 2048;
  const parts = [];
  const dropped = [];
  const warnings = [];
  let used = 0;

  const orderedSources = priority
    ? [...sources].sort((a, b) => {
        const ai = priority.indexOf(a.type);
        const bi = priority.indexOf(b.type);
        const aRank = ai === -1 ? priority.length : ai;
        const bRank = bi === -1 ? priority.length : bi;
        return aRank - bRank;
      })
    : sources;

  for (const source of orderedSources) {
    if (source.type === 'docs' && Array.isArray(source.stores)) {
      const { stores, vector, limit = 5, filter, strategy } = source;
      const settled = await Promise.allSettled(stores.map(store => {
        const call = (strategy === 'hybrid' && typeof store.hybridSearch === 'function')
          ? store.hybridSearch(query, vector, limit, filter)
          : store.similaritySearch(vector, limit, filter);
        return call;
      }));
      const successfulLists = [];
      settled.forEach((res, i) => {
        if (res.status === 'fulfilled') {
          successfulLists.push(res.value);
        } else {
          warnings.push({ store: i, error: String(res.reason?.message || res.reason) });
        }
      });
      const fused = _reciprocalRankFusion(successfulLists);
      for (const doc of fused) {
        const content = doc.content || '';
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'docs', metadata: doc.metadata || {} });
          continue;
        }
        parts.push({ source: 'docs', type: 'docs', content, tokens });
        used += tokens;
      }
      continue;
    }
    if (source.type === 'docs') {
      for (const item of (source.items || [])) {
        const content = item.content || '';
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'docs', metadata: item.metadata || {} });
          continue;
        }
        parts.push({ source: 'docs', type: 'docs', content, tokens });
        used += tokens;
      }
    }
    if (source.type === 'memory') {
      if (!source.factStore || !source.sessionId) continue;
      const facts = await source.factStore.read(source.sessionId, query);
      for (const fact of (facts || [])) {
        const content = `${fact.subject} ${fact.predicate} ${fact.object}`;
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'memory', fact });
          continue;
        }
        parts.push({ source: 'memory', type: 'memory', content, tokens });
        used += tokens;
      }
    }
    if (source.type === 'history') {
      const messages = source.messages || [];
      for (const m of messages) {
        const content = `${String(m.role).toUpperCase()}: ${m.content}`;
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'history' });
          continue;
        }
        parts.push({ source: 'history', type: 'history', content, tokens });
        used += tokens;
      }
    }
    if (source.type === 'tools') {
      for (const result of (source.results || [])) {
        const content = `Tool: ${result.name}\nResult: ${result.output}`;
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'tools', name: result.name });
          continue;
        }
        parts.push({ source: 'tools', type: 'tools', content, tokens });
        used += tokens;
      }
    }
  }

  return {
    parts,
    text: parts.map(p => p.content).join('\n---\n'),
    tokensUsed: used,
    tokensBudget: maxTokens,
    dropped,
    warnings,
  };
}

module.exports = { estimateTokensCached, _clearTokenCache, _encodeForTest, buildContext };
