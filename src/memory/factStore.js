const { safeIdent } = require('../memory');
const { v4: uuidv4 } = require('uuid');

const EXTRACTION_PROMPT = `Extract factual (subject, predicate, object) triples from the conversation turn below. Only extract clear, stated facts about the user or entities discussed — not questions, greetings, or the assistant's own commentary. Return strict JSON only, no prose: {"facts": [{"subject": "...", "predicate": "...", "object": "..."}]}. If there are no clear facts, return {"facts": []}.

User: {{USER}}
Assistant: {{ASSISTANT}}`;

class FactStore {
  constructor(config) {
    this.client = config.clientInstance;
    this.tableName = safeIdent(config.tableName || 'VectraFact');
    this.llm = config.llm;
    this.embedder = config.embedder;
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

  async write(sessionId, turn) {
    if (!sessionId || !this.llm || !this.embedder) return;
    const prompt = EXTRACTION_PROMPT
      .replace('{{USER}}', turn.userMessage || '')
      .replace('{{ASSISTANT}}', turn.assistantMessage || '');

    let facts;
    try {
      const raw = await this.llm.generate(prompt, 'You extract structured facts as strict JSON.');
      const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);
      facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    } catch (_) {
      return;
    }

    facts = facts.filter(f => f && f.subject && f.predicate && f.object);
    if (facts.length === 0) return;

    const texts = facts.map(f => `${f.subject} ${f.predicate} ${f.object}`);
    let embeddings;
    try {
      embeddings = await this.embedder.embedDocuments(texts);
    } catch (_) {
      return;
    }

    const t = this.tableName;
    await this._withConn(async (client) => {
      for (let i = 0; i < facts.length; i++) {
        const f = facts[i];
        const vec = `[${embeddings[i].join(',')}]`;

        const existing = await client.query(
          `SELECT "id","object" FROM "${t}" WHERE "sessionId" = $1 AND "subject" = $2 AND "predicate" = $3 AND "invalidAt" IS NULL`,
          [sessionId, f.subject, f.predicate]
        );
        const existingRow = existing.rows[0];

        if (existingRow && existingRow.object === f.object) {
          continue;
        }
        if (existingRow) {
          try {
            await client.query(`UPDATE "${t}" SET "invalidAt" = NOW() WHERE "id" = $1`, [existingRow.id]);
          } catch (_) {}
        }

        const id = uuidv4();
        try {
          await client.query(
            `INSERT INTO "${t}" ("id","sessionId","subject","predicate","object","embedding","sourceMessageId") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, sessionId, f.subject, f.predicate, f.object, vec, turn.sourceMessageId || null]
          );
        } catch (_) {}
      }
    });
  }
}

module.exports = { FactStore };
