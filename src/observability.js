const { v4: uuidv4 } = require('uuid');
const path = require('path');

class SQLiteLogger {
  constructor(config) {
    this.enabled = config.enabled;
    if (!this.enabled) return;

    this.projectId = config.projectId;
    this.trackMetrics = config.trackMetrics;
    this.trackTraces = config.trackTraces;
    this.trackLogs = config.trackLogs;
    this.sessionTracking = config.sessionTracking;

    try {
        const rawPath = config.sqlitePath || 'vectra-observability.db';
        const dbPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
        // Ensure directory exists
        const dbDir = path.dirname(dbPath);
        
        const fs = require('fs');
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }

        const sqlite3 = require('sqlite3').verbose();
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) throw err;
            this.db.run('PRAGMA journal_mode = WAL');
            this.db.run('PRAGMA synchronous = NORMAL');
        });
        this.initializeSchema();
        this.traceBuffer = [];
        this.metricBuffer = [];
        this.logBuffer = [];
        this.bufferLimit = 50;
        
        if (this.enabled) {
          this.flushInterval = setInterval(() => this.flush(), 5000);
        }
    } catch (error) {
        throw error;
    }
  }

  initializeSchema() {
    this.db.serialize(() => {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS traces (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                trace_id TEXT,
                span_id TEXT,
                parent_span_id TEXT,
                name TEXT,
                start_time INTEGER,
                end_time INTEGER,
                duration INTEGER,
                status TEXT,
                attributes TEXT, -- JSON
                input TEXT, -- JSON
                output TEXT, -- JSON
                error TEXT, -- JSON
                provider TEXT,
                model_name TEXT
            )
        `);

        // Attempt to add columns if they don't exist (migration)
        this.db.run(`ALTER TABLE traces ADD COLUMN provider TEXT`, () => {});
        this.db.run(`ALTER TABLE traces ADD COLUMN model_name TEXT`, () => {});

        this.db.run(`
            CREATE TABLE IF NOT EXISTS metrics (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                name TEXT,
                value REAL,
                timestamp INTEGER,
                tags TEXT -- JSON
            )
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS logs (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                level TEXT,
                message TEXT,
                timestamp INTEGER,
                context TEXT -- JSON
            )
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                session_id TEXT,
                user_id TEXT,
                start_time INTEGER,
                last_activity_time INTEGER,
                metadata TEXT -- JSON
            )
        `);
    });
  }

  logTrace(trace) {
    if (!this.enabled || !this.trackTraces) return;
    this.traceBuffer.push({ ...trace, id: uuidv4(), timestamp: Date.now() });
    if (this.traceBuffer.length >= this.bufferLimit) this.flush();
  }

  flush() {
    if (!this.enabled) return;
    this.db.serialize(() => {
        this.db.run("BEGIN TRANSACTION");
        
        if (this.traceBuffer.length > 0) {
            const stmt = this.db.prepare(`
                INSERT INTO traces (id, project_id, trace_id, span_id, parent_span_id, name, start_time, end_time, duration, status, attributes, input, output, error, provider, model_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const t of this.traceBuffer) {
                stmt.run(
                    t.id, this.projectId, t.traceId, t.spanId, t.parentSpanId || null, t.name,
                    t.startTime, t.endTime, t.duration, t.status,
                    JSON.stringify(t.attributes || {}), JSON.stringify(t.input || {}),
                    JSON.stringify(t.output || {}), JSON.stringify(t.error || {}),
                    t.provider || null, t.modelName || null
                );
            }
            stmt.finalize();
            this.traceBuffer = [];
        }

        if (this.metricBuffer.length > 0) {
            const stmt = this.db.prepare(`
                INSERT INTO metrics (id, project_id, name, value, timestamp, tags)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            for (const m of this.metricBuffer) {
                stmt.run(uuidv4(), this.projectId, m.name, m.value, m.timestamp, JSON.stringify(m.tags || {}));
            }
            stmt.finalize();
            this.metricBuffer = [];
        }

        if (this.logBuffer.length > 0) {
            const stmt = this.db.prepare(`
                INSERT INTO logs (id, project_id, level, message, timestamp, context)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            for (const l of this.logBuffer) {
                stmt.run(uuidv4(), this.projectId, l.level, l.message, l.timestamp, JSON.stringify(l.context || {}));
            }
            stmt.finalize();
            this.logBuffer = [];
        }

        this.db.run("COMMIT", (err) => {
            if (err) console.error('Failed to commit SQLite txn:', err);
        });
    });
  }

  logMetric(nameOrObj, value, tags = {}) {
    if (!this.enabled || !this.trackMetrics) return;
    const name = (typeof nameOrObj === 'object') ? nameOrObj.name : nameOrObj;
    const val = (typeof nameOrObj === 'object') ? nameOrObj.value : value;
    const tgs = (typeof nameOrObj === 'object') ? (nameOrObj.tags || {}) : tags;
    this.metricBuffer.push({ name, value: val, tags: tgs, timestamp: Date.now() });
    if (this.metricBuffer.length >= this.bufferLimit) this.flush();
  }

  log(level, message, context = {}) {
    if (!this.enabled || !this.trackLogs) return;
    this.logBuffer.push({ level, message, context, timestamp: Date.now() });
    if (this.logBuffer.length >= this.bufferLimit) this.flush();
  }

  logSession(sessionId, userId, metadata = {}) {
      if (!this.enabled || !this.sessionTracking) return;
      try {
          // Check if session exists (upsert logic if needed, but here simple insert/update)
          // For simplicity, we just insert or ignore, or update last_activity
          // Since sqlite3 doesn't support UPSERT in older versions easily without ON CONFLICT, let's try INSERT OR REPLACE
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO sessions (id, project_id, session_id, user_id, start_time, last_activity_time, metadata)
            VALUES (
                COALESCE((SELECT id FROM sessions WHERE session_id = ?), ?),
                ?, ?, ?, 
                COALESCE((SELECT start_time FROM sessions WHERE session_id = ?), ?),
                ?, ?
            )
          `);
          
          const now = Date.now();
          const newId = uuidv4();
          
          stmt.run(
              sessionId, newId,
              this.projectId,
              sessionId,
              userId,
              sessionId, now,
              now,
              JSON.stringify(metadata)
          );
          stmt.finalize();
      } catch (error) {
          console.error('Failed to log session:', error);
      }
  }
}

module.exports = SQLiteLogger;
