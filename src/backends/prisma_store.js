const { v4: uuidv4 } = require('uuid');
const { VectorStore } = require('../interfaces');

class PrismaVectorStore extends VectorStore {
  constructor(config) { 
      super();
      this.config = config; 
  }
  normalizeVector(v) {
    const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return m === 0 ? v : v.map(x => x / m);
  }
  async addDocuments(docs) {
    const { clientInstance, tableName, columnMap } = this.config;
    for (const doc of docs) {
        const vec = JSON.stringify(this.normalizeVector(doc.embedding));
        // Use configured column names or defaults
        const cContent = columnMap.content || 'content';
        const cMeta = columnMap.metadata || 'metadata';
        const cVec = columnMap.vector || 'vector';

        const q = `INSERT INTO "${tableName}" ("id", "${cContent}", "${cMeta}", "${cVec}", "createdAt") VALUES ('${uuidv4()}', $1, $2, $3::vector, NOW())`;
        await clientInstance.$executeRawUnsafe(q, doc.content, doc.metadata, vec);
    }
  }
  async similaritySearch(vector, limit = 5, filter = null) {
    const { clientInstance, tableName, columnMap } = this.config;
    const cContent = columnMap.content || 'content';
    const cMeta = columnMap.metadata || 'metadata';
    const cVec = columnMap.vector || 'vector';

    const vec = JSON.stringify(this.normalizeVector(vector));
    let where = "", params = [vec];
    if (filter) { where = `WHERE "${cMeta}" @> $2::jsonb`; params.push(JSON.stringify(filter)); }
    const q = `SELECT "${cContent}" as content, "${cMeta}" as metadata, 1 - ("${cVec}" <=> $1::vector) as score FROM "${tableName}" ${where} ORDER BY score DESC LIMIT ${limit}`;
    const res = await clientInstance.$queryRawUnsafe(q, ...params);
    return res.map(r => ({ content: r.content, metadata: r.metadata, score: r.score }));
  }
}
module.exports = { PrismaVectorStore };