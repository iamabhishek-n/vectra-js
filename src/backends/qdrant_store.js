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
  async hybridSearch(text, vector, limit = 5, filter = null) { return this.similaritySearch(vector, limit, filter); }
  async listDocuments({ filter = null, limit = 100, offset = 0 } = {}) {
    if (typeof this.client.scroll !== 'function') throw new Error('listDocuments is not supported for this Qdrant client');
    const qFilter = this.normalizeFilter(filter);
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    let skipped = 0;
    let out = [];
    let nextOffset = undefined;
    while (out.length < lim) {
      const res = await this.client.scroll(this.collection, { limit: Math.min(256, lim), filter: qFilter, offset: nextOffset });
      const points = res?.points || res?.result?.points || [];
      nextOffset = res?.next_page_offset || res?.result?.next_page_offset || res?.next_page_offset;
      if (!points.length) break;
      for (const p of points) {
        if (skipped < off) { skipped++; continue; }
        out.push({ id: p.id, content: p.payload?.content, metadata: p.payload?.metadata });
        if (out.length >= lim) break;
      }
      if (!nextOffset) break;
    }
    return out;
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
