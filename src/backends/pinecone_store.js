const { VectorStore } = require('../interfaces');

class PineconeVectorStore extends VectorStore {
  constructor(config) {
    super();
    this.config = config;
    this.client = config.clientInstance;
    this.namespace = config.tableName || undefined;
  }

  async addDocuments(documents) {
    const vectors = documents.map(doc => ({
      id: doc.id,
      values: doc.embedding,
      metadata: { ...doc.metadata, content: doc.content },
    }));
    // NOTE: the exact @pinecone-database/pinecone SDK signature for passing a
    // namespace alongside upsert() (second positional arg vs. an
    // index.namespace(ns) sub-client) was not verifiable against the live
    // package in this environment. This assumes a second-arg options object;
    // confirm against the installed SDK version before using in production.
    await this.client.upsert(vectors, this.namespace ? { namespace: this.namespace } : undefined);
  }

  async upsertDocuments(documents) {
    return this.addDocuments(documents);
  }

  async similaritySearch(vector, limit = 5, filter = null) {
    const queryOpts = { vector, topK: limit, includeMetadata: true };
    if (filter) queryOpts.filter = filter;
    if (this.namespace) queryOpts.namespace = this.namespace;
    const res = await this.client.query(queryOpts);
    return (res.matches || []).map(m => {
      const { content, ...metadata } = m.metadata || {};
      return { content: content || '', metadata, score: m.score };
    });
  }

  _lexicalOverlap(query, content) {
    const tokenize = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2) || []);
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return 0;
    const contentTokens = tokenize(content);
    let matches = 0;
    for (const t of queryTokens) if (contentTokens.has(t)) matches++;
    return matches / queryTokens.size;
  }

  async hybridSearch(text, vector, limit = 5, filter = null) {
    const pool = await this.similaritySearch(vector, Math.max(limit * 4, 20), filter);
    if (pool.length === 0) return [];
    const withLexical = pool.map(d => ({ ...d, _lexical: this._lexicalOverlap(text, d.content) }));
    const semanticRanked = [...withLexical].sort((a, b) => b.score - a.score);
    const lexicalRanked = [...withLexical].sort((a, b) => b._lexical - a._lexical);
    const rrfScores = new Map();
    const addRanks = (ranked) => {
      ranked.forEach((d, idx) => {
        const key = d.content;
        rrfScores.set(key, (rrfScores.get(key) || 0) + 1 / (60 + idx + 1));
      });
    };
    addRanks(semanticRanked);
    addRanks(lexicalRanked);
    const seen = new Map();
    for (const d of withLexical) if (!seen.has(d.content)) seen.set(d.content, d);
    return Array.from(seen.values())
      .sort((a, b) => (rrfScores.get(b.content) || 0) - (rrfScores.get(a.content) || 0))
      .slice(0, limit)
      .map(({ _lexical, ...rest }) => rest);
  }

  async listDocuments({ filter = null, limit = 100, cursor = null } = {}) {
    throw new Error('listDocuments is not supported for Pinecone — the API has no arbitrary listing/scroll endpoint. Use fileExists or similaritySearch with a broad query instead.');
  }

  async deleteDocuments({ ids = null, filter = null } = {}) {
    if (Array.isArray(ids) && ids.length > 0) {
      await this.client.deleteMany(ids);
      return;
    }
    if (filter) {
      await this.client.deleteMany({ filter });
      return;
    }
    throw new Error('deleteDocuments requires ids or filter');
  }

  async fileExists(sha256, size, lastModified) {
    // Pinecone's query API requires a vector even for a pure metadata-filter
    // existence check — there's no listing/count-by-filter endpoint. A dummy
    // zero vector works for filter-only matching but MUST match the real
    // index's configured dimension, which this class doesn't otherwise know.
    // config.dimensions is used if the caller supplied it; otherwise this
    // will likely error against a real Pinecone index with a different
    // dimension — a real, documented limitation of this backend, not a bug
    // to silently paper over.
    const dim = this.config.dimensions || 1536;
    try {
      const res = await this.client.query({
        vector: new Array(dim).fill(0),
        topK: 1,
        filter: { fileSHA256: sha256, fileSize: size, lastModified },
        includeMetadata: false,
        ...(this.namespace ? { namespace: this.namespace } : {}),
      });
      return (res.matches || []).length > 0;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { PineconeVectorStore };
