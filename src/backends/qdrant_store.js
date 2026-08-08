const { VectorStore } = require('../interfaces');

class QdrantVectorStore extends VectorStore {
  constructor(config) { super(); this.config = config; this.client = config.clientInstance; this.collection = config.tableName || 'rag_collection'; }

  normalizeFilter(filter) {
    if (!filter) return null;
    if (typeof filter !== 'object') return filter;
    if (filter.must || filter.should || filter.must_not) return filter;
    const must = [];
    Object.entries(filter).forEach(([k, v]) => {
      if (v === undefined) return;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        must.push({ key: `metadata.${k}`, match: { value: v } });
      }
    });
    return must.length ? { must } : null;
  }

  async addDocuments(documents) {
    const points = documents.map((doc, i) => ({ id: doc.id || `${Date.now()}-${i}`, vector: doc.embedding, payload: { content: doc.content, metadata: doc.metadata } }));
    await this.client.upsert(this.collection, { points });
  }
  async upsertDocuments(documents) {
    return this.addDocuments(documents);
  }
  async similaritySearch(vector, limit = 5, filter = null) {
    const qFilter = this.normalizeFilter(filter);
    const res = await this.client.search(this.collection, { vector, limit, filter: qFilter });
    return res.map(r => ({ content: r.payload.content, metadata: r.payload.metadata, score: r.score }));
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
    if (typeof this.client.scroll !== 'function') throw new Error('listDocuments is not supported for this Qdrant client');
    const qFilter = this.normalizeFilter(filter);
    const lim = Math.max(1, Number(limit) || 100);
    const res = await this.client.scroll(this.collection, { 
      limit: lim, 
      filter: qFilter, 
      offset: cursor || undefined,
      with_payload: true,
      with_vector: false
    });
    const points = res?.points || res?.result?.points || [];
    const nextCursor = res?.next_page_offset || res?.result?.next_page_offset;
    const docs = points.map(p => ({
      id: p.id,
      content: p.payload?.content,
      metadata: p.payload?.metadata
    }));
    return { documents: docs, nextCursor };
  }
  async fileExists(sha256, size, lastModified) {
    const filter = this.normalizeFilter({ fileSHA256: sha256, fileSize: size, lastModified });
    try {
      const res = await this.client.scroll(this.collection, { limit: 1, filter });
      const points = res?.points || res?.result?.points || [];
      return points.length > 0;
    } catch (_) {
      return false;
    }
  }
  async deleteDocuments({ ids = null, filter = null } = {}) {
    if (typeof this.client.delete !== 'function') throw new Error('deleteDocuments is not supported for this Qdrant client');
    if (Array.isArray(ids) && ids.length > 0) {
      await this.client.delete(this.collection, { points: ids });
      return;
    }
    if (filter) {
      await this.client.delete(this.collection, { filter: this.normalizeFilter(filter) });
      return;
    }
    throw new Error('deleteDocuments requires ids or filter');
  }
}
module.exports = { QdrantVectorStore };
