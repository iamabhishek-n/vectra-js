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
