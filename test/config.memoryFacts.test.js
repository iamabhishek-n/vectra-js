const { RAGConfigSchema } = require('../src/config');

describe('memory.facts config', () => {
  it('defaults to disabled when not specified', () => {
    const parsed = RAGConfigSchema.parse({
      embedding: { provider: 'openai', modelName: 'text-embedding-3-small' },
      llm: { provider: 'openai', modelName: 'gpt-4o-mini' },
      database: { type: 'postgres', clientInstance: {} },
    });
    expect(parsed.memory?.facts?.enabled ?? false).toBe(false);
  });

  it('accepts an explicit facts config', () => {
    const client = {};
    const parsed = RAGConfigSchema.parse({
      embedding: { provider: 'openai', modelName: 'text-embedding-3-small' },
      llm: { provider: 'openai', modelName: 'gpt-4o-mini' },
      database: { type: 'postgres', clientInstance: {} },
      memory: { enabled: true, facts: { enabled: true, clientInstance: client, tableName: 'MyFacts' } },
    });
    expect(parsed.memory.facts.enabled).toBe(true);
    expect(parsed.memory.facts.tableName).toBe('MyFacts');
  });
});
