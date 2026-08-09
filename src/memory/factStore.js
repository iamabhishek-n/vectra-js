const { safeIdent } = require('../memory');

class FactStore {
  constructor(config) {
    this.client = config.clientInstance;
    this.tableName = safeIdent(config.tableName || 'VectraFact');
  }

  async _withConn(fn) {
    if (typeof this.client.connect === 'function') {
      const c = await this.client.connect();
      try { return await fn(c); } finally { c.release(); }
    }
    return fn(this.client);
  }

  async ensureIndexes(dimensions = 1536) {
    const t = this.tableName;
    const dim = dimensions || 1536;
    await this._withConn(async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`CREATE TABLE IF NOT EXISTS "${t}" (
        "id" TEXT PRIMARY KEY,
        "sessionId" TEXT NOT NULL,
        "subject" TEXT NOT NULL,
        "predicate" TEXT NOT NULL,
        "object" TEXT NOT NULL,
        "embedding" vector(${dim}),
        "validAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "invalidAt" TIMESTAMP WITH TIME ZONE,
        "sourceMessageId" TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      try {
        await client.query(`CREATE INDEX IF NOT EXISTS "${t}_vec_idx" ON "${t}" USING hnsw ("embedding" vector_cosine_ops)`);
      } catch (e) {
        try { await client.query(`CREATE INDEX IF NOT EXISTS "${t}_vec_idx" ON "${t}" USING ivfflat ("embedding" vector_cosine_ops)`); } catch (_) {}
      }
      await client.query(`CREATE INDEX IF NOT EXISTS "${t}_session_temporal_idx" ON "${t}" ("sessionId", "validAt", "invalidAt")`);
      await client.query(`CREATE INDEX IF NOT EXISTS "${t}_subject_predicate_idx" ON "${t}" ("sessionId", "subject", "predicate")`);
    });
  }
}

module.exports = { FactStore };
