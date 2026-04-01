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

class PostgresVectorStore extends VectorStore {
  constructor(config) {
    super();
    this.config = config;
    const tableName = config.tableName || 'document';
    const columnMap = config.columnMap || {};
    this._table = quoteTableName(tableName, 'tableName');
    this._tableBase = tableName.split('.').pop();
    this._cContent = quoteIdentifier(columnMap.content || 'content', 'columnMap.content');
    this._cMeta = quoteIdentifier(columnMap.metadata || 'metadata', 'columnMap.metadata');
    this._cVec = quoteIdentifier(columnMap.vector || 'vector', 'columnMap.vector');
    this._cCreatedAt = '"createdAt"';
    
    // We expect config.clientInstance to be a pg.Pool or pg.Client
    if (!this.config.clientInstance) {
        throw new Error('PostgresVectorStore requires a clientInstance (pg.Pool or pg.Client)');
    }
    this.client = this.config.clientInstance;
  }

  async _withConn(fn) {
    if (typeof this.client.connect === 'function') {
        const client = await this.client.connect();
        try { return await fn(client); } finally { client.release(); }
    }
    return fn(this.client);
  }

  normalizeVector(v) {
    const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return m === 0 ? v : v.map(x => x / m);
  }

  // Helper to ensure table and extension exist
  async ensureIndexes() {
    await this._withConn(async (client) => {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        
        try {
          const typeCheck = await client.query(
            `SELECT data_type, udt_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
            [this._tableBase, this._cVec.replace(/"/g, '')]
          );
          const row = typeCheck.rows[0];
          if (row && row.data_type && row.data_type.toLowerCase().includes('array') && row.udt_name !== 'vector') {
              throw new Error('Postgres schema mismatch: vector column is array. Use vector(<dimensions>).');
          }
        } catch (e) {
          if (String(e.message || e).includes('schema mismatch')) throw e;
        }
        
        const dim = 1536;
        await client.query(`CREATE TABLE IF NOT EXISTS ${this._table} ("id" TEXT PRIMARY KEY, ${this._cContent} TEXT, ${this._cMeta} JSONB, ${this._cVec} vector(${dim}), "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW())`);
        
        try {
          const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [this._tableBase]);
          const cols = new Set(res.rows.map(r => r.column_name));
          if (!cols.has(this._cContent.replace(/"/g, ''))) await client.query(`ALTER TABLE ${this._table} ADD COLUMN ${this._cContent} TEXT`);
          if (!cols.has(this._cMeta.replace(/"/g, ''))) await client.query(`ALTER TABLE ${this._table} ADD COLUMN ${this._cMeta} JSONB`);
          if (!cols.has(this._cVec.replace(/"/g, ''))) await client.query(`ALTER TABLE ${this._table} ADD COLUMN ${this._cVec} vector(${dim})`);
          if (!cols.has('createdAt')) await client.query(`ALTER TABLE ${this._table} ADD COLUMN "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()`);
        } catch (_) {}
        
        try {
            await client.query(`CREATE INDEX IF NOT EXISTS "${this._table.replace(/"/g, '')}_vec_idx" ON ${this._table} USING hnsw (${this._cVec} vector_cosine_ops)`);
        } catch (e) {
            try { await client.query(`CREATE INDEX IF NOT EXISTS "${this._table.replace(/"/g, '')}_vec_idx" ON ${this._table} USING ivfflat (${this._cVec} vector_cosine_ops)`); } catch (_) {}
        }
    });
  }

  async addDocuments(docs) {
    const q = `INSERT INTO ${this._table} ("id", ${this._cContent}, ${this._cMeta}, ${this._cVec}, "createdAt") VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT ("id") DO NOTHING`;
    await this._withConn(async (client) => {
      for (const doc of docs) {
        const id = doc.id || uuidv4();
        const vec = `[${this.normalizeVector(doc.embedding).join(',')}]`;
        try {
          await client.query(q, [id, doc.content, doc.metadata, vec]);
        } catch (e) {
          const msg = e?.message || String(e);
          if (msg.includes('vector') && msg.includes('dimension')) throw new Error('DimensionMismatchError');
          throw e;
        }
      }
    });
  }

  async upsertDocuments(docs) {
      const q = `
        INSERT INTO ${this._table} ("id", ${this._cContent}, ${this._cMeta}, ${this._cVec}, "createdAt") 
        VALUES ($1, $2, $3, $4, NOW()) 
        ON CONFLICT ("id") 
        DO UPDATE SET 
            ${this._cContent} = EXCLUDED.${this._cContent}, 
            ${this._cMeta} = EXCLUDED.${this._cMeta}, 
            ${this._cVec} = EXCLUDED.${this._cVec}
      `;
      
      await this._withConn(async (client) => {
        for (const doc of docs) {
          const id = doc.id || uuidv4();
          const vec = `[${this.normalizeVector(doc.embedding).join(',')}]`;
          await client.query(q, [id, doc.content, doc.metadata, vec]);
        }
      });
  }

  async similaritySearch(vector, limit = 5, filter = null) {
    const vec = `[${this.normalizeVector(vector).join(',')}]`;
    let where = ""; 
    const params = [vec];
    
    if (filter) { 
        where = `WHERE ${this._cMeta} @> $2`; 
        params.push(filter); 
    }
    
    const limitIdx = params.length + 1;
    // <=> is cosine distance. 1 - distance = similarity (roughly)
    const q = `
        SELECT ${this._cContent} as content, ${this._cMeta} as metadata, 1 - (${this._cVec} <=> $1) as score 
        FROM ${this._table} 
        ${where} 
        ORDER BY ${this._cVec} <=> $1 ASC 
        LIMIT $${limitIdx}
    `;
    params.push(Math.max(1, Number(limit) || 5));

    const res = await this._withConn(c => c.query(q, params));
    return res.rows.map(r => ({ content: r.content, metadata: r.metadata, score: r.score }));
  }

  async hybridSearch(text, vector, limit = 5, filter = null) {
    // 1. Semantic search
    const semantic = await this.similaritySearch(vector, limit * 2, filter);
    
    // 2. Keyword search using to_tsvector
    // We assume english config 'simple' or 'english'
    const params = [text];
    let where = "";
    if (filter) {
        where = `AND ${this._cMeta} @> $2`;
        params.push(filter);
    }
    const limitIdx = params.length + 1;
    
    const q = `
        SELECT ${this._cContent} as content, ${this._cMeta} as metadata 
        FROM ${this._table} 
        WHERE to_tsvector('english', ${this._cContent}) @@ plainto_tsquery('english', $1) 
        ${where} 
        LIMIT $${limitIdx}
    `;
    params.push(Math.max(1, Number(limit) || 5) * 2);

    let lexical = [];
    try {
        const res = await this._withConn(c => c.query(q, params));
        lexical = res.rows.map(r => ({ content: r.content, metadata: r.metadata, score: 1.0 }));
    } catch (e) {
        console.warn("Keyword search failed (maybe missing indexes):", e.message);
        lexical = [];
    }

    // 3. Reciprocal Rank Fusion
    const combined = {};
    const add = (list, weight = 1) => {
      list.forEach((doc, idx) => {
        const key = doc.content; // Use content as key if id not returned, ideally use id
        // But doc structure returned by similaritySearch might not have id unless we select it
        // existing implementations use content as key often in simple RRF
        const score = 1 / (60 + idx + 1) * weight;
        if (!combined[key]) combined[key] = { ...doc, score: 0 };
        combined[key].score += score;
      });
    };
    add(semantic, 1);
    add(lexical, 1);
    
    return Object.values(combined).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  
  async listDocuments({ filter = null, limit = 100, cursor = null } = {}) {
    return this._withConn(async (client) => {
      const params = [];
      const whereParts = [];
      if (filter) {
        whereParts.push(`${this._cMeta} @> $${params.length + 1}`);
        params.push(filter);
      }
      if (cursor) {
        whereParts.push(`"id" > $${params.length + 1}`);
        params.push(cursor);
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
      const lim = Math.max(1, Number(limit) || 100);
      const q = `SELECT "id", ${this._cContent} as content, ${this._cMeta} as metadata FROM ${this._table} ${where} ORDER BY "id" ASC LIMIT $${params.length + 1}`;
      params.push(lim);
      const res = await client.query(q, params);
      const docs = res.rows.map(r => ({ id: r.id, content: r.content, metadata: r.metadata }));
      const nextCursor = docs.length === lim ? docs[docs.length - 1].id : null;
      return { documents: docs, nextCursor };
    });
  }

  async fileExists(sha256, size, lastModified) {
    try {
      const q = `
        SELECT 1 
        FROM ${this._table} 
        WHERE ${this._cMeta} @> $1 
        LIMIT 1
      `;
      const metaFilter = JSON.stringify({ fileSHA256: sha256, fileSize: size, lastModified });
      const res = await this._withConn(c => c.query(q, [metaFilter]));
      return res.rowCount > 0;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { PostgresVectorStore };
