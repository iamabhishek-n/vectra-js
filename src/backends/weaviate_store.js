const { VectorStore } = require('../interfaces');

class WeaviateVectorStore extends VectorStore {
  constructor(config) {
    super();
    this.config = config;
    this.client = config.clientInstance;
    this.className = config.tableName || 'Document';
    this.collection = this.client.collections.get(this.className);
  }

  _buildFilter(filter) {
    if (!filter) return undefined;
    // NOTE: the exact filter-builder API (`collection.filter.byProperty(...).equal(...)`)
    // was not verifiable against a live weaviate-client install in this environment.
    // Passing the raw filter object through assumes the caller's clientInstance mock
    // (or a future adapter) accepts a plain equality-map shape. Flagged for
    // confirmation before production use, same as the upsert-namespace assumption
    // already carried by PineconeVectorStore.
    return filter;
  }

  async addDocuments(documents) {
    const objects = documents.map(doc => ({
      id: doc.id,
      properties: { content: doc.content, metadata: JSON.stringify(doc.metadata || {}) },
      vector: doc.embedding,
    }));
    await this.collection.data.insertMany(objects);
  }

  async upsertDocuments(documents) {
    return this.addDocuments(documents);
  }

  _mapObject(o) {
    const metadata = o.properties && o.properties.metadata ? JSON.parse(o.properties.metadata) : {};
    const distance = o.metadata ? o.metadata.distance : undefined;
    return {
      content: (o.properties && o.properties.content) || '',
      metadata,
      score: typeof distance === 'number' ? 1 - distance : undefined,
    };
  }

  async similaritySearch(vector, limit = 5, filter = null) {
    const opts = { limit, returnMetadata: ['distance'] };
    const f = this._buildFilter(filter);
    if (f) opts.filters = f;
    const res = await this.collection.query.nearVector(vector, opts);
    return (res.objects || []).map(o => this._mapObject(o));
  }

  async hybridSearch(text, vector, limit = 5, filter = null) {
    const opts = { vector, limit, alpha: 0.5, returnMetadata: ['score'] };
    const f = this._buildFilter(filter);
    if (f) opts.filters = f;
    const res = await this.collection.query.hybrid(text, opts);
    return (res.objects || []).map(o => ({
      content: (o.properties && o.properties.content) || '',
      metadata: o.properties && o.properties.metadata ? JSON.parse(o.properties.metadata) : {},
      score: o.metadata ? o.metadata.score : undefined,
    }));
  }

  async listDocuments({ filter = null, limit = 100, cursor = null } = {}) {
    const opts = { limit };
    const f = this._buildFilter(filter);
    if (f) opts.filters = f;
    if (cursor) opts.after = cursor;
    const res = await this.collection.query.fetchObjects(opts);
    const objects = res.objects || [];
    const docs = objects.map(o => ({
      id: o.uuid,
      content: (o.properties && o.properties.content) || '',
      metadata: o.properties && o.properties.metadata ? JSON.parse(o.properties.metadata) : {},
    }));
    const nextCursor = objects.length === limit ? objects[objects.length - 1].uuid : null;
    return [docs, nextCursor];
  }

  async deleteDocuments({ ids = null, filter = null } = {}) {
    if (Array.isArray(ids) && ids.length > 0) {
      await Promise.all(ids.map(id => this.collection.data.deleteById(id)));
      return;
    }
    if (filter) {
      const f = this._buildFilter(filter);
      await this.collection.data.deleteMany(f);
      return;
    }
    throw new Error('deleteDocuments requires ids or filter');
  }

  async fileExists(sha256, size, lastModified) {
    // Unlike PineconeVectorStore, Weaviate's fetchObjects takes filters without
    // requiring a placeholder vector — a genuine capability advantage over Pinecone,
    // not an oversight.
    try {
      const res = await this.collection.query.fetchObjects({
        limit: 1,
        filters: this._buildFilter({ fileSHA256: sha256, fileSize: size, lastModified }),
      });
      return (res.objects || []).length > 0;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { WeaviateVectorStore };
