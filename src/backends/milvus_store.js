const { VectorStore } = require('../interfaces');

class MilvusVectorStore extends VectorStore {
  constructor(config) { super(); this.config = config; this.client = config.clientInstance; this.collection = config.tableName || 'rag_collection'; }
  async addDocuments(documents) {
    const data = documents.map((doc) => ({ vector: doc.embedding, content: doc.content, metadata: JSON.stringify(doc.metadata) }));
    await this.client.insert({ collection_name: this.collection, fields_data: data });
  }
  async upsertDocuments(documents) {
    return this.addDocuments(documents);
  }
  async similaritySearch(vector, limit = 5, filter = null) {
    const lim = Math.max(1, Number(limit) || 5);
    let res;
    if (filter) {
      try {
        res = await this.client.search({ collection_name: this.collection, data: [vector], limit: lim, filter });
      } catch (_) {
        try {
          res = await this.client.search({ collection_name: this.collection, data: [vector], limit: lim, expr: filter });
        } catch (_) {
          res = await this.client.search({ collection_name: this.collection, data: [vector], limit: lim });
        }
      }
    } else {
      res = await this.client.search({ collection_name: this.collection, data: [vector], limit: lim });
    }
    const hits = res.results ? res.results : res;
    return hits.map(h => ({ content: h.content || '', metadata: h.metadata ? JSON.parse(h.metadata) : {}, score: h.distance }));
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
    const semanticRanked = [...withLexical].sort((a, b) => a.score - b.score);
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
    if (typeof this.client.query !== 'function') throw new Error('listDocuments is not supported for this Milvus client');
    const lim = Math.max(1, Number(limit) || 100);
    const off = cursor ? Number(cursor) : 0;
    const res = await this.client.query({
      collection_name: this.collection,
      expr: filter || '',
      output_fields: ['id', 'content', 'metadata'],
      limit: lim,
      offset: off,
    });
    const rows = Array.isArray(res) ? res : (res?.data || res?.results || []);
    const docs = rows.map((r) => ({ id: r.id, content: r.content || '', metadata: r.metadata ? JSON.parse(r.metadata) : {} }));
    const nextCursor = docs.length === lim ? String(off + docs.length) : null;
    return { documents: docs, nextCursor };
  }

  async fileExists(sha256, size, lastModified) {
    if (typeof this.client.query !== 'function') return false;
    try {
      const expr = '';
      const res = await this.client.query({
        collection_name: this.collection,
        expr,
        output_fields: ['content', 'metadata'],
        limit: 1
      });
      const rows = Array.isArray(res) ? res : (res?.data || res?.results || []);
      return rows.some((r) => {
        try {
          const m = r.metadata ? JSON.parse(r.metadata) : {};
          return m.fileSHA256 === sha256 && m.fileSize === size && m.lastModified === lastModified;
        } catch (_) { return false; }
      });
    } catch (_) {
      return false;
    }
  }

  async deleteDocuments({ ids = null, filter = null } = {}) {
    if (typeof this.client.delete !== 'function') throw new Error('deleteDocuments is not supported for this Milvus client');
    if (Array.isArray(ids) && ids.length > 0) {
      await this.client.delete({ collection_name: this.collection, ids });
      return;
    }
    if (filter) {
      await this.client.delete({ collection_name: this.collection, expr: filter });
      return;
    }
    throw new Error('deleteDocuments requires ids or filter');
  }
}
module.exports = { MilvusVectorStore };
