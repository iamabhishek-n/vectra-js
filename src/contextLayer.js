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

async function buildContext(input) {
  const { query, budget = {}, sources = [], priority } = input;
  const maxTokens = budget.maxTokens ?? 2048;
  const parts = [];
  const dropped = [];
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
    warnings: [],
  };
}

module.exports = { estimateTokensCached, _clearTokenCache, _encodeForTest, buildContext };
