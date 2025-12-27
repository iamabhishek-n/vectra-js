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
        console.log(`[SQLiteLogger] dbPath: ${dbPath}, dbDir: ${dbDir}`);
        
        const fs = require('fs');
        if (!fs.existsSync(dbDir)) {
          console.log(`[SQLiteLogger] Creating directory: ${dbDir}`);
          fs.mkdirSync(dbDir, { recursive: true });
        } else {
          console.log(`[SQLiteLogger] Directory exists: ${dbDir}`);
        }

        const sqlite3 = require('sqlite3').verbose();
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Failed to connect to SQLite database:', err);
                throw err;
            }
        });
        this.initializeSchema();
    } catch (error) {
        console.error('Failed to initialize SQLite logger:', error);
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
    try {
      const stmt = this.db.prepare(`
        INSERT INTO traces (id, project_id, trace_id, span_id, parent_span_id, name, start_time, end_time, duration, status, attributes, input, output, error, provider, model_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        uuidv4(),
        this.projectId,
        trace.traceId,
        trace.spanId,
        trace.parentSpanId || null,
        trace.name,
        trace.startTime,
        trace.endTime,
        trace.duration,
        trace.status,
        JSON.stringify(trace.attributes || {}),
        JSON.stringify(trace.input || {}),
        JSON.stringify(trace.output || {}),
        JSON.stringify(trace.error || {}),
        trace.provider || null,
        trace.modelName || null
      );
      stmt.finalize();
    } catch (error) {
      console.error('Failed to log trace:', error);
    }
  }

  logMetric(nameOrObj, value, tags = {}) {
    if (!this.enabled || !this.trackMetrics) return;
    
    let metricName = nameOrObj;
    let metricValue = value;
    let metricTags = tags;

    if (typeof nameOrObj === 'object' && nameOrObj !== null) {
        metricName = nameOrObj.name;
        metricValue = nameOrObj.value;
        metricTags = nameOrObj.tags || {};
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO metrics (id, project_id, name, value, timestamp, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        uuidv4(),
        this.projectId,
        metricName,
        metricValue,
        Date.now(),
        JSON.stringify(metricTags)
      );
      stmt.finalize();
    } catch (error) {
      console.error('Failed to log metric:', error);
    }
  }

  log(level, message, context = {}) {
    if (!this.enabled || !this.trackLogs) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO logs (id, project_id, level, message, timestamp, context)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        uuidv4(),
        this.projectId,
        level,
        message,
        Date.now(),
        JSON.stringify(context)
      );
      stmt.finalize();
    } catch (error) {
      console.error('Failed to log message:', error);
    }
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
