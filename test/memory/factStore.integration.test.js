const { FactStore } = require('../../src/memory/factStore');

// A more realistic fake: actually stores/updates/filters rows, rather than
// returning canned responses per query shape like the per-task unit tests do.
class InMemoryFakeConn {
  constructor() { this.rows = []; }
  async query(q, params) {
    if (q.includes('CREATE TABLE') || q.includes('CREATE INDEX') || q.includes('CREATE EXTENSION')) {
      return { rows: [] };
    }
    if (q.includes('SELECT') && q.includes('"invalidAt" IS NULL') && q.includes('"subject" = $2')) {
      const [sessionId, subject, predicate] = params;
      return { rows: this.rows.filter(r => r.sessionId === sessionId && r.subject === subject && r.predicate === predicate && !r.invalidAt) };
    }
    if (q.includes('UPDATE') && q.includes('"invalidAt"')) {
      const [id] = params;
      const row = this.rows.find(r => r.id === id);
      if (row) row.invalidAt = new Date();
      return { rows: [] };
    }
    if (q.includes('INSERT INTO')) {
      const [id, sessionId, subject, predicate, object] = params;
      this.rows.push({ id, sessionId, subject, predicate, object, validAt: new Date(), invalidAt: null });
      return { rows: [] };
    }
    if (q.includes('SELECT') && q.includes('ORDER BY')) {
      const [sessionId] = params;
      return { rows: this.rows.filter(r => r.sessionId === sessionId && !r.invalidAt).map(r => ({ id: r.id, subject: r.subject, predicate: r.predicate, object: r.object, validAt: r.validAt, invalidAt: r.invalidAt })) };
    }
    return { rows: [] };
  }
}

describe('FactStore end-to-end', () => {
  it('write then read round-trips a fact', async () => {
    const conn = new InMemoryFakeConn();
    const llm = { generate: jest.fn(async () => JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'coffee' }] })) };
    const embedder = { embedDocuments: jest.fn(async (t) => t.map(() => [0.1])), embedQuery: jest.fn(async () => [0.1]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });

    await store.write('session-1', { userMessage: 'I like coffee', assistantMessage: 'Noted!' });
    const facts = await store.read('session-1', 'what does the user like');

    expect(facts).toHaveLength(1);
    expect(facts[0].object).toBe('coffee');
  });

  it('a superseding fact replaces the old one in read results, never both', async () => {
    const conn = new InMemoryFakeConn();
    const embedder = { embedDocuments: jest.fn(async (t) => t.map(() => [0.1])), embedQuery: jest.fn(async () => [0.1]) };
    const llmSeq = [
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'lives_in', object: 'Berlin' }] }),
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'lives_in', object: 'Tokyo' }] }),
    ];
    let call = 0;
    const llm = { generate: jest.fn(async () => llmSeq[call++]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });

    await store.write('session-1', { userMessage: 'I live in Berlin', assistantMessage: 'Cool!' });
    await store.write('session-1', { userMessage: 'I moved to Tokyo', assistantMessage: 'Wow!' });
    const facts = await store.read('session-1', 'where does the user live');

    const livesInFacts = facts.filter(f => f.predicate === 'lives_in');
    expect(livesInFacts).toHaveLength(1);
    expect(livesInFacts[0].object).toBe('Tokyo');
  });

  it('facts from a different session never leak into another session\'s read', async () => {
    const conn = new InMemoryFakeConn();
    const embedder = { embedDocuments: jest.fn(async (t) => t.map(() => [0.1])), embedQuery: jest.fn(async () => [0.1]) };
    const llm = { generate: jest.fn(async () => JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'coffee' }] })) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });

    await store.write('session-A', { userMessage: 'I like coffee', assistantMessage: 'Noted!' });
    const factsB = await store.read('session-B', 'what does the user like');

    expect(factsB).toHaveLength(0);
  });
});
