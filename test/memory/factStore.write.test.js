const { FactStore } = require('../../src/memory/factStore');

class FakeConn {
  constructor() {
    this.inserted = [];
    this.query = jest.fn(async (q, params) => {
      if (q.includes('INSERT INTO')) this.inserted.push(params);
      return { rows: [] };
    });
  }
}

function makeStore({ llmResponse, embedResponse }) {
  const conn = new FakeConn();
  const llm = { generate: jest.fn(async () => llmResponse) };
  const embedder = { embedDocuments: jest.fn(async (texts) => texts.map(() => embedResponse || [0.1, 0.2])) };
  const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });
  return { store, conn, llm, embedder };
}

describe('FactStore.write', () => {
  it('extracts triples via the LLM and inserts them as new facts', async () => {
    const { store, conn, llm, embedder } = makeStore({
      llmResponse: JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'coffee' }] }),
    });

    await store.write('session-1', { userMessage: 'I really like coffee', assistantMessage: 'Noted!' });

    expect(llm.generate).toHaveBeenCalledTimes(1);
    expect(embedder.embedDocuments).toHaveBeenCalledTimes(1);
    expect(conn.inserted).toHaveLength(1);
    const [id, sessionId, subject, predicate, object] = conn.inserted[0];
    expect(sessionId).toBe('session-1');
    expect(subject).toBe('user');
    expect(predicate).toBe('likes');
    expect(object).toBe('coffee');
  });

  it('extracts multiple triples from one turn', async () => {
    const { store, conn } = makeStore({
      llmResponse: JSON.stringify({ facts: [
        { subject: 'user', predicate: 'likes', object: 'coffee' },
        { subject: 'user', predicate: 'lives_in', object: 'Berlin' },
      ] }),
    });

    await store.write('session-1', { userMessage: 'I like coffee and I live in Berlin', assistantMessage: 'Cool!' });

    expect(conn.inserted).toHaveLength(2);
  });

  it('does not throw when the LLM returns malformed JSON, and inserts nothing', async () => {
    const { store, conn } = makeStore({ llmResponse: 'not json at all {{{' });

    await expect(store.write('session-1', { userMessage: 'hi', assistantMessage: 'hello' })).resolves.not.toThrow();
    expect(conn.inserted).toHaveLength(0);
  });

  it('does not throw when the LLM returns an empty facts array', async () => {
    const { store, conn } = makeStore({ llmResponse: JSON.stringify({ facts: [] }) });

    await store.write('session-1', { userMessage: 'hi', assistantMessage: 'hello' });

    expect(conn.inserted).toHaveLength(0);
  });

  it('is a no-op when sessionId is missing', async () => {
    const { store, conn, llm } = makeStore({ llmResponse: JSON.stringify({ facts: [] }) });

    await store.write(null, { userMessage: 'hi', assistantMessage: 'hello' });

    expect(llm.generate).not.toHaveBeenCalled();
    expect(conn.inserted).toHaveLength(0);
  });
});
