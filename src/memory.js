class InMemoryHistory {
  constructor(maxMessages = 20) {
    this.sessions = new Map();
    this.maxMessages = maxMessages;
  }
  addMessage(sessionId, role, content) {
    if (!sessionId) return;
    const arr = this.sessions.get(sessionId) || [];
    arr.push({ role, content, ts: Date.now() });
    const start = Math.max(0, arr.length - this.maxMessages);
    this.sessions.set(sessionId, arr.slice(start));
  }
  getRecent(sessionId, n = 10) {
    const arr = this.sessions.get(sessionId) || [];
    const start = Math.max(0, arr.length - n);
    return arr.slice(start);
  }
}
class RedisHistory {
  constructor(client, keyPrefix = 'vectra:chat:', maxMessages = 20) {
    this.client = client;
    this.keyPrefix = keyPrefix;
    this.maxMessages = maxMessages;
  }
  async addMessage(sessionId, role, content) {
    if (!sessionId || !this.client) return;
    const key = `${this.keyPrefix}${sessionId}`;
    const payload = JSON.stringify({ role, content, ts: Date.now() });
    try {
      if (typeof this.client.rpush === 'function') {
        await this.client.rpush(key, payload);
      } else if (typeof this.client.lPush === 'function') {
        await this.client.lPush(key, payload);
      }
      if (typeof this.client.ltrim === 'function') {
        await this.client.ltrim(key, -this.maxMessages, -1);
      }
    } catch (_) {}
  }
  async getRecent(sessionId, n = 10) {
    if (!sessionId || !this.client) return [];
    const key = `${this.keyPrefix}${sessionId}`;
    try {
      let arr = [];
      if (typeof this.client.lrange === 'function') {
        arr = await this.client.lrange(key, -n, -1);
      } else if (typeof this.client.lRange === 'function') {
        arr = await this.client.lRange(key, -n, -1);
      }
      return arr.map(x => {
        try { return JSON.parse(x); } catch { return { role: 'assistant', content: String(x) }; }
      });
    } catch (_) {
      return [];
    }
  }
}
class PostgresHistory {
  constructor(client, tableName = 'ChatMessage', columnMap = { sessionId: 'sessionId', role: 'role', content: 'content', createdAt: 'createdAt' }, maxMessages = 20) {
    this.client = client;
    this.tableName = tableName;
    this.columnMap = columnMap;
    this.maxMessages = maxMessages;
  }
  async addMessage(sessionId, role, content) {
    if (!sessionId || !this.client) return;
    const t = this.tableName;
    const c = this.columnMap;
    const q = `INSERT INTO "${t}" ("${c.sessionId}","${c.role}","${c.content}","${c.createdAt}") VALUES ($1,$2,$3,NOW())`;
    try {
      if (typeof this.client.$executeRawUnsafe === 'function') {
        await this.client.$executeRawUnsafe(q, sessionId, role, content);
      } else if (typeof this.client.execute_raw === 'function') {
        await this.client.execute_raw(q, sessionId, role, content);
      }
    } catch (_) {}
  }
  async getRecent(sessionId, n = 10) {
    if (!sessionId || !this.client) return [];
    const t = this.tableName;
    const c = this.columnMap;
    const q = `SELECT "${c.role}" as role, "${c.content}" as content FROM "${t}" WHERE "${c.sessionId}" = $1 ORDER BY "${c.createdAt}" DESC LIMIT ${Math.max(1, n)}`;
    try {
      let rows = [];
      if (typeof this.client.$queryRawUnsafe === 'function') {
        rows = await this.client.$queryRawUnsafe(q, sessionId);
      } else if (typeof this.client.query_raw === 'function') {
        rows = await this.client.query_raw(q, sessionId);
      }
      return Array.isArray(rows) ? rows.reverse().map(r => ({ role: r.role, content: r.content })) : [];
    } catch (_) {
      return [];
    }
  }
}
module.exports = { InMemoryHistory, RedisHistory, PostgresHistory };
