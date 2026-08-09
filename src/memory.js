const safeIdent = (name) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
};

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
    this.tableName = safeIdent(tableName);
    this.columnMap = {};
    for (const [k, v] of Object.entries(columnMap)) {
      this.columnMap[k] = safeIdent(v);
    }
    this.maxMessages = maxMessages;
  }
  async _withConn(fn) {
    if (typeof this.client.connect === 'function') {
      const c = await this.client.connect();
      try { return await fn(c); } finally { c.release(); }
    }
    return fn(this.client);
  }
  async addMessage(sessionId, role, content) {
    if (!sessionId || !this.client) return;
    const t = this.tableName;
    const c = this.columnMap;
    const q = `INSERT INTO "${t}" ("${c.sessionId}","${c.role}","${c.content}","${c.createdAt}") VALUES ($1,$2,$3,NOW())`;
    try {
      await this._withConn(async (conn) => {
        if (typeof conn.$executeRawUnsafe === 'function') {
          await conn.$executeRawUnsafe(q, sessionId, role, content);
        } else if (typeof conn.query === 'function') {
          await conn.query(q, [sessionId, role, content]);
        }
      });
    } catch (_) {}
  }
  async getRecent(sessionId, n = 10) {
    if (!sessionId || !this.client) return [];
    const t = this.tableName;
    const c = this.columnMap;
    const q = `SELECT "${c.role}" as role, "${c.content}" as content FROM "${t}" WHERE "${c.sessionId}" = $1 ORDER BY "${c.createdAt}" DESC LIMIT ${Math.max(1, n)}`;
    try {
      const rows = await this._withConn(async (conn) => {
        if (typeof conn.$queryRawUnsafe === 'function') {
          return await conn.$queryRawUnsafe(q, sessionId);
        } else if (typeof conn.query === 'function') {
          const res = await conn.query(q, [sessionId]);
          return res.rows;
        }
        return [];
      });
      return Array.isArray(rows) ? rows.reverse().map(r => ({ role: r.role, content: r.content })) : [];
    } catch (_) {
      return [];
    }
  }
}
module.exports = { InMemoryHistory, RedisHistory, PostgresHistory, safeIdent };
