const { FactStore } = require('../../src/memory/factStore');

class FakeConn {
  constructor(existingFacts = []) {
    this.existingFacts = existingFacts;
    this.inserted = [];
    this.invalidated = [];
    this.query = jest.fn(async (q, params) => {
      if (q.includes('SELECT') && q.includes('"invalidAt" IS NULL')) {
        return { rows: this.existingFacts.filter(f => f.subject === params[1] && f.predicate === params[2]) };
      }
      if (q.includes('UPDATE') && q.includes('"invalidAt"')) {
        this.invalidated.push(params[0]);
        return { rows: [] };
      }
      if (q.includes('INSERT INTO')) {
        this.inserted.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    });
  }
}

function makeStore(existingFacts, llmResponse) {
  const conn = new FakeConn(existingFacts);
  const llm = { generate: jest.fn(async () => llmResponse) };
  const embedder = { embedDocuments: jest.fn(async (texts) => texts.map(() => [0.1, 0.2])) };
  const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });
  return { store, conn };
}

describe('FactStore contradiction/invalidation', () => {
  it('invalidates the old fact and inserts a new one when the object changes', async () => {
    const { store, conn } = makeStore(
      [{ id: 'old-1', subject: 'user', predicate: 'lives_in', object: 'Berlin' }],
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'lives_in', object: 'Tokyo' }] })
    );

    await store.write('session-1', { userMessage: 'I moved to Tokyo', assistantMessage: 'Nice!' });

    expect(conn.invalidated).toContain('old-1');
    expect(conn.inserted).toHaveLength(1);
    expect(conn.inserted[0][4]).toBe('Tokyo');
  });

  it('does not insert a duplicate when the exact same fact already exists and is valid', async () => {
    const { store, conn } = makeStore(
      [{ id: 'old-1', subject: 'user', predicate: 'likes', object: 'coffee' }],
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'coffee' }] })
    );

    await store.write('session-1', { userMessage: 'I still like coffee', assistantMessage: 'Great!' });

    expect(conn.invalidated).toHaveLength(0);
    expect(conn.inserted).toHaveLength(0);
  });

  it('inserts as new when no existing fact shares subject+predicate', async () => {
    const { store, conn } = makeStore(
      [],
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'tea' }] })
    );

    await store.write('session-1', { userMessage: 'I like tea', assistantMessage: 'Noted!' });

    expect(conn.invalidated).toHaveLength(0);
    expect(conn.inserted).toHaveLength(1);
  });
});
