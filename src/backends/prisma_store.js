const { v4: uuidv4 } = require('uuid');
const { VectorStore } = require('../interfaces');

const isSafeIdentifier = (value) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const assertSafeIdentifier = (value, label) => {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier for ${label}`);
};
const quoteIdentifier = (value, label) => {
  assertSafeIdentifier(value, label);
  return `"${value}"`;
};
const quoteTableName = (value, label) => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Unsafe SQL identifier for ${label}`);
  const parts = value.split('.').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) throw new Error(`Unsafe SQL identifier for ${label}`);
  parts.forEach((p, i) => assertSafeIdentifier(p, i === 0 && parts.length === 2 ? `${label} schema` : `${label} table`));
  return parts.map(p => `"${p}"`).join('.');
};

class PrismaVectorStore extends VectorStore {
  constructor(config) { 
      super();
      this.config = config; 
      const tableName = config.tableName || 'Document';
      const columnMap = config.columnMap || {};
      this._table = quoteTableName(tableName, 'tableName');
      this._tableBase = tableName.split('.').pop();
      this._cContent = quoteIdentifier(columnMap.content || 'content', 'columnMap.content');
      this._cMeta = quoteIdentifier(columnMap.metadata || 'metadata', 'columnMap.metadata');
      this._cVec = quoteIdentifier(columnMap.vector || 'vector', 'columnMap.vector');
  }
  normalizeVector(v) {
    const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return m === 0 ? v : v.map(x => x / m);
  }
  async addDocuments(docs) {
    const { clientInstance } = this.config;
    const q = `INSERT INTO ${this._table} ("id", ${this._cContent}, ${this._cMeta}, ${this._cVec}, "createdAt") VALUES ($1, $2, $3, $4::vector, NOW())`;
    for (const doc of docs) {
        const id = doc.id || uuidv4();
        const vec = JSON.stringify(this.normalizeVector(doc.embedding));
        try {
          await clientInstance.$executeRawUnsafe(q, id, doc.content, doc.metadata, vec);
        } catch (e) {
          const msg = e?.message || String(e);
          if (msg.includes('vector') && msg.includes('dimension')) {
            throw new Error('DimensionMismatchError: Embedding dimension does not match pgvector column. Configure embedding.dimensions to match the column or migrate the column dimension.');
          }
          throw e;
        }
    }
  }

  async upsertDocuments(docs) {
    const { clientInstance } = this.config;
    const q = `INSERT INTO ${this._table} ("id", ${this._cContent}, ${this._cMeta}, ${this._cVec}, "createdAt") VALUES ($1, $2, $3, $4::vector, NOW()) ON CONFLICT ("id") DO UPDATE SET ${this._cContent} = EXCLUDED.${this._cContent}, ${this._cMeta} = EXCLUDED.${this._cMeta}, ${this._cVec} = EXCLUDED.${this._cVec}`;
    for (const doc of docs) {
      const id = doc.id || uuidv4();
      const vec = JSON.stringify(this.normalizeVector(doc.embedding));
      await clientInstance.$executeRawUnsafe(q, id, doc.content, doc.metadata, vec);
    }
  }

  async similaritySearch(vector, limit = 5, filter = null) {
    const { clientInstance } = this.config;

    const vec = JSON.stringify(this.normalizeVector(vector));
    let where = ""; const params = [vec];
    if (filter) { where = `WHERE ${this._cMeta} @> $2::jsonb`; params.push(JSON.stringify(filter)); }
    const q = `SELECT ${this._cContent} as content, ${this._cMeta} as metadata, 1 - (${this._cVec} <=> $1::vector) as score FROM ${this._table} ${where} ORDER BY score DESC LIMIT ${Math.max(1, Number(limit) || 5)}`;
    const res = await clientInstance.$queryRawUnsafe(q, ...params);
    return res.map(r => ({ content: r.content, metadata: r.metadata, score: r.score }));
  }

  async hybridSearch(text, vector, limit = 5, filter = null) {
    const semantic = await this.similaritySearch(vector, limit * 2, filter);
    const { clientInstance } = this.config;
    const params = [text];
    const where = filter ? ` AND ${this._cMeta} @> $2::jsonb` : '';
    if (filter) params.push(JSON.stringify(filter));
    const q = `SELECT ${this._cContent} as content, ${this._cMeta} as metadata FROM ${this._table} WHERE to_tsvector('simple', ${this._cContent}) @@ plainto_tsquery($1)${where} LIMIT ${Math.max(1, Number(limit) || 5) * 2}`;
    let lexical = [];
    try {
      const res = await clientInstance.$queryRawUnsafe(q, ...params);
      lexical = res.map(r => ({ content: r.content, metadata: r.metadata, score: 1.0 }));
    } catch (_) {
      lexical = [];
    }
    const combined = {};
    const add = (list, weight = 1) => {
      list.forEach((doc, idx) => {
        const key = doc.content;
        const score = 1 / (60 + idx + 1) * weight;
        if (!combined[key]) combined[key] = { ...doc, score: 0 };
        combined[key].score += score;
      });
    };
    add(semantic, 1);
    add(lexical, 1);
    return Object.values(combined).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async ensureIndexes() {
    const { clientInstance } = this.config;
    const base = this._tableBase;
    assertSafeIdentifier(base, 'tableName table');
    const idxVec = `"${base}_embedding_ivfflat"`;
    const idxFts = `"${base}_content_fts_gin"`;
    try {
      await clientInstance.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
      await clientInstance.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ${idxVec} ON ${this._table} USING ivfflat (${this._cVec} vector_cosine_ops) WITH (lists = 100);`);
      await clientInstance.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ${idxFts} ON ${this._table} USING GIN (to_tsvector('english', ${this._cContent}));`);
    } catch (e) {
      // Best-effort; indexes are optional
    }
  }
  
  async fileExists(sha256, size, lastModified) {
    const { clientInstance } = this.config;
    const payload = JSON.stringify({ fileSHA256: sha256, fileSize: size, lastModified });
    const q = `SELECT 1 FROM ${this._table} WHERE ${this._cMeta} @> $1::jsonb LIMIT 1`;
    try {
      const res = await clientInstance.$queryRawUnsafe(q, payload);
      return Array.isArray(res) && res.length > 0;
    } catch (_) {
      return false;
    }
  }

  async listDocuments({ filter = null, limit = 100, offset = 0 } = {}) {
    const { clientInstance } = this.config;
    const params = [];
    let where = '';
    if (filter) {
      where = `WHERE ${this._cMeta} @> $1::jsonb`;
      params.push(JSON.stringify(filter));
    }
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const q = `SELECT "id" as id, ${this._cContent} as content, ${this._cMeta} as metadata, "createdAt" as createdAt FROM ${this._table} ${where} ORDER BY "createdAt" DESC LIMIT ${lim} OFFSET ${off}`;
    const res = await clientInstance.$queryRawUnsafe(q, ...params);
    return res.map(r => ({ id: r.id, content: r.content, metadata: r.metadata, createdAt: r.createdAt }));
  }

  async deleteDocuments({ ids = null, filter = null } = {}) {
    const { clientInstance } = this.config;
    if (Array.isArray(ids) && ids.length > 0) {
      const q = `DELETE FROM ${this._table} WHERE "id" = ANY($1::uuid[])`;
      await clientInstance.$executeRawUnsafe(q, ids);
      return;
    }
    if (filter) {
      const q = `DELETE FROM ${this._table} WHERE ${this._cMeta} @> $1::jsonb`;
      await clientInstance.$executeRawUnsafe(q, JSON.stringify(filter));
      return;
    }
    throw new Error('deleteDocuments requires ids or filter');
  }
}
module.exports = { PrismaVectorStore };
