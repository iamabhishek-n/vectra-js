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

  normalizeVector(v) {
    const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return m === 0 ? v : v.map(x => x / m);
  }

  // Helper to ensure table and extension exist
  async ensureIndexes() {
    // Enable pgvector extension
    await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');
    
    // Detect existing column type to avoid malformed array issues
    try {
      const typeCheck = await this.client.query(
        `SELECT data_type, udt_name 
         FROM information_schema.columns 
         WHERE table_name = $1 AND column_name = $2`,
        [this._tableBase, this._cVec.replace(/"/g, '')]
      );
      const row = typeCheck.rows[0];
      if (row) {
        const isPgVector = row.udt_name === 'vector';
        const isArray = row.data_type && row.data_type.toLowerCase().includes('array');
        if (isArray && !isPgVector) {
          throw new Error(
            'Postgres schema mismatch: vector column is double precision[] (array). ' +
            'Use pgvector type: vector(<dimensions>). ' +
            'Example: ALTER TABLE ' + this._table + ' ALTER COLUMN ' + this._cVec + ' TYPE vector(1536);'
          );
        }
      }
    } catch (e) {
      // Only throw if we explicitly detected array type; otherwise continue
      if (String(e.message || e).includes('schema mismatch')) {
        throw e;
      }
    }
    
    // Create table if not exists (best-effort)
    // Note: We need to know vector dimensions. We'll try to guess or use default 1536
    // If embedding dimensions are provided in config, use them
    // But store config usually doesn't have embedding config directly unless passed down
    // For now we will assume the user creates the table or we default to 1536 (OpenAI)
    // A better approach is to rely on user schema, but for convenience:
    const dim = 1536; // Default to OpenAI dimension if unknown.
    // However, if the table exists, we don't change it.
    
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${this._table} (
        "id" TEXT PRIMARY KEY,
        ${this._cContent} TEXT,
        ${this._cMeta} JSONB,
        ${this._cVec} vector(${dim}),
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    await this.client.query(createTableQuery);
    
    // Ensure required columns exist (non-destructive)
    try {
      const res = await this.client.query(
        `SELECT column_name, data_type, udt_name 
         FROM information_schema.columns 
         WHERE table_name = $1`,
        [this._tableBase]
      );
      const cols = new Map(res.rows.map(r => [r.column_name, r]));
      const contentCol = this._cContent.replace(/"/g, '');
      const metaCol = this._cMeta.replace(/"/g, '');
      const vecCol = this._cVec.replace(/"/g, '');
      const createdAtCol = this._cCreatedAt.replace(/"/g, '');
      
      if (!cols.has(contentCol)) {
        await this.client.query(`ALTER TABLE ${this._table} ADD COLUMN ${this._cContent} TEXT`);
      }
      if (!cols.has(metaCol)) {
        await this.client.query(`ALTER TABLE ${this._table} ADD COLUMN ${this._cMeta} JSONB`);
      }
      if (!cols.has(vecCol)) {
        await this.client.query(`ALTER TABLE ${this._table} ADD COLUMN ${this._cVec} vector(${dim})`);
      } else {
        const vinfo = cols.get(vecCol);
        const isPgVector = vinfo && vinfo.udt_name === 'vector';
        const isArray = vinfo && vinfo.data_type && vinfo.data_type.toLowerCase().includes('array');
        if (isArray && !isPgVector) {
          throw new Error(
            'Postgres schema mismatch: vector column is double precision[] (array). ' +
            'Use pgvector type: vector(' + dim + '). ' +
            'Example: ALTER TABLE ' + this._table + ' ALTER COLUMN ' + this._cVec + ' TYPE vector(' + dim + ');'
          );
        }
      }
      if (!cols.has(createdAtCol)) {
        await this.client.query(`ALTER TABLE ${this._table} ADD COLUMN ${this._cCreatedAt} TIMESTAMP WITH TIME ZONE DEFAULT NOW()`);
      }
    } catch (_) {
      // best-effort; ignore
    }
    
    // Create HNSW index for faster search
    // checking if index exists is hard in raw sql cross-version, 
    // simpler to CREATE INDEX IF NOT EXISTS which pg supports in recent versions
    // or catch error
    try {
        await this.client.query(`CREATE INDEX IF NOT EXISTS "${this._table.replace(/"/g, '')}_vec_idx" ON ${this._table} USING hnsw (${this._cVec} vector_cosine_ops)`);
    } catch (e) {
        // Fallback to ivfflat when hnsw not supported
        try {
          await this.client.query(`CREATE INDEX IF NOT EXISTS "${this._table.replace(/"/g, '')}_vec_idx" ON ${this._table} USING ivfflat (${this._cVec} vector_cosine_ops)`);
        } catch (e2) {
          console.warn('Could not create vector index (might be fine if not supported):', e.message);
        }
    }
  }

  async addDocuments(docs) {
    const q = `INSERT INTO ${this._table} ("id", ${this._cContent}, ${this._cMeta}, ${this._cVec}, "createdAt") VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT ("id") DO NOTHING`;
    
    for (const doc of docs) {
      const id = doc.id || uuidv4();
      const vec = `[${this.normalizeVector(doc.embedding).join(',')}]`; // pgvector format
      try {
        await this.client.query(q, [id, doc.content, doc.metadata, vec]);
      } catch (e) {
        const msg = e?.message || String(e);
        if (msg.includes('vector') && msg.includes('dimension')) {
           throw new Error('DimensionMismatchError: Embedding dimension does not match pgvector column.');
        }
        throw e;
      }
    }
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
      
      for (const doc of docs) {
        const id = doc.id || uuidv4();
        const vec = `[${this.normalizeVector(doc.embedding).join(',')}]`;
        await this.client.query(q, [id, doc.content, doc.metadata, vec]);
      }
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

    const res = await this.client.query(q, params);
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
        const res = await this.client.query(q, params);
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
  
  async fileExists(sha256, size, lastModified) {
    try {
      const q = `
        SELECT 1 
        FROM ${this._table} 
        WHERE ${this._cMeta} @> $1 
        LIMIT 1
      `;
      const metaFilter = JSON.stringify({ fileSHA256: sha256, fileSize: size, lastModified });
      const res = await this.client.query(q, [metaFilter]);
      return res.rowCount > 0;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { PostgresVectorStore };
