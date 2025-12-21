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
  async hybridSearch(text, vector, limit = 5, filter = null) { return this.similaritySearch(vector, limit, filter); }

  async listDocuments({ filter = null, limit = 100, offset = 0 } = {}) {
    if (typeof this.client.query !== 'function') throw new Error('listDocuments is not supported for this Milvus client');
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const res = await this.client.query({
      collection_name: this.collection,
      expr: filter || '',
      output_fields: ['content', 'metadata'],
      limit: lim,
      offset: off,
    });
    const rows = Array.isArray(res) ? res : (res?.data || res?.results || []);
    return rows.map((r) => ({ id: r.id, content: r.content || '', metadata: r.metadata ? JSON.parse(r.metadata) : {} }));
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
