const http = require('http');
const fs = require('fs');
const path = require('path');
const { ProviderType, ChunkingStrategy, RetrievalStrategy } = require('./config');
const telemetry = require('./telemetry');
const sqlite3 = require('sqlite3').verbose();


// Helper to get DB connection from config
const getDb = (configPath) => {
    try {
        if (!fs.existsSync(configPath)) return null;
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!cfg.observability || !cfg.observability.enabled) return null;
        
        let dbPath = cfg.observability.sqlitePath || 'vectra-observability.db';
        if (!path.isAbsolute(dbPath)) {
             dbPath = path.resolve(path.dirname(configPath), dbPath);
        }

        return new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    } catch (e) {
        console.error('Failed to open observability DB:', e);
        return null;
    }
};

// Promisify sqlite3 methods
const dbQuery = (db, method, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db[method](sql, params, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
};

// Simple browser opener using child_process since 'open' package might not be installed
const { exec } = require('child_process');
const openBrowser = (url) => {
  const start = (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
  exec(start + ' ' + url);
};

const DEFAULT_CONFIG = {
  embedding: {
    provider: ProviderType.OPENAI,
    apiKey: "",
    modelName: "text-embedding-3-small",
    dimensions: null
  },
  llm: {
    provider: ProviderType.GEMINI,
    apiKey: "",
    modelName: "gemini-1.5-pro-latest",
    temperature: 0,
    maxTokens: 1024
  },
  database: {
    type: "prisma",
    tableName: "Document",
    columnMap: { content: "content", vector: "vector", metadata: "metadata" }
  },
  chunking: {
    strategy: ChunkingStrategy.RECURSIVE,
    chunkSize: 1000,
    chunkOverlap: 200,
    separators: ["\n\n", "\n", " ", ""]
  },
  retrieval: {
    strategy: RetrievalStrategy.NAIVE,
    hybridAlpha: 0.5
  },
  reranking: {
    enabled: false,
    provider: "llm",
    topN: 5,
    windowSize: 20
  }
};

function serveStatic(res, filePath, contentType) {
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
}

function start(configPath, mode = 'webconfig', port = 8766, openInBrowser = true) {
  const absConfigPath = path.resolve(configPath);
  
  // Init telemetry
  let cfg = {};
  try {
      if (fs.existsSync(absConfigPath)) cfg = JSON.parse(fs.readFileSync(absConfigPath, 'utf-8'));
  } catch (_) {}
  telemetry.init(cfg);
  telemetry.track('feature_used', { feature: mode }); // mode is 'webconfig' or 'dashboard'
  
  const createServer = (currentPort) => {
    const server = http.createServer((req, res) => {
      const sendJson = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // --- Dashboard Routes ---

      // Redirect /dashboard to /dashboard/ to handle relative assets correctly
      if (req.method === 'GET' && req.url === '/dashboard') {
        res.writeHead(301, { 'Location': '/dashboard/' });
        res.end();
        return;
      }

      // Serve Dashboard HTML
      if (req.method === 'GET' && req.url === '/dashboard/') {
        const filePath = path.join(__dirname, 'dashboard', 'index.html');
        serveStatic(res, filePath, 'text/html; charset=utf-8');
        return;
      }

      // Serve Dashboard Assets
      if (req.method === 'GET' && req.url.startsWith('/dashboard/')) {
        const assetName = req.url.split('?')[0].replace('/dashboard/', '');
        const filePath = path.join(__dirname, 'dashboard', assetName);
        if (fs.existsSync(filePath)) {
             const ext = path.extname(filePath);
             let type = 'text/plain';
             if (ext === '.css') type = 'text/css';
             if (ext === '.js') type = 'application/javascript';
             if (ext === '.html') type = 'text/html';
             
             serveStatic(res, filePath, type);
             return;
        }
      }

      // --- Observability API ---
      
      if (req.method === 'GET' && req.url.startsWith('/api/observability/')) {
          const db = getDb(absConfigPath);
          if (!db) {
              sendJson(400, { error: 'Observability not enabled or DB not found' });
              return;
          }

          const handleRequest = async () => {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const projectId = url.searchParams.get('projectId');
              // Sanitize projectId to avoid injection if possible, though strict typing helps. 
              // Using parameterized queries is safer.
              
              let projectFilter = '';
              const params = [];
              
              if (projectId && projectId !== 'all') {
                  projectFilter = 'WHERE project_id = ?';
                  params.push(projectId);
              }

              try {
                  if (url.pathname.endsWith('/stats')) {
                      // Aggregate stats
                      // Fix: projectFilter starts with WHERE, but here we append to existing WHERE if name='queryRAG'.
                      // So: WHERE name='queryRAG' AND project_id = ?
                      const whereClause = projectFilter ? `AND project_id = ?` : '';
                      
                      const totalReq = await dbQuery(db, 'get', `SELECT COUNT(*) as count FROM traces WHERE name = 'queryRAG' ${whereClause}`, params);
                      
                      const avgLat = await dbQuery(db, 'get', `SELECT AVG(value) as val FROM metrics WHERE name = 'query_latency' ${whereClause}`, params);
                      const tokensP = await dbQuery(db, 'get', `SELECT SUM(value) as val FROM metrics WHERE name = 'prompt_chars' ${whereClause}`, params);
                      const tokensC = await dbQuery(db, 'get', `SELECT SUM(value) as val FROM metrics WHERE name = 'completion_chars' ${whereClause}`, params);
                      
                      // History for charts (last 50 query latencies)
                      const history = await dbQuery(db, 'all', `
                          SELECT m.timestamp, m.value as latency, 
                          (SELECT value FROM metrics m2 WHERE m2.timestamp = m.timestamp AND m2.name = 'prompt_chars') + 
                          (SELECT value FROM metrics m3 WHERE m3.timestamp = m.timestamp AND m3.name = 'completion_chars') as tokens
                          FROM metrics m 
                          WHERE m.name = 'query_latency' ${whereClause}
                          ORDER BY m.timestamp DESC LIMIT 50
                      `, params);

                      sendJson(200, {
                          totalRequests: totalReq ? totalReq.count : 0,
                          avgLatency: avgLat ? avgLat.val : 0,
                          totalPromptChars: tokensP ? tokensP.val : 0,
                          totalCompletionChars: tokensC ? tokensC.val : 0,
                          history: history ? history.reverse() : []
                      });
                  }
                  else if (url.pathname.endsWith('/traces')) {
                      const whereClause = projectFilter ? `AND project_id = ?` : '';
                      const traces = await dbQuery(db, 'all', `SELECT * FROM traces WHERE name = 'queryRAG' ${whereClause} ORDER BY start_time DESC LIMIT 50`, params);
                      sendJson(200, traces);
                  }
                  else if (url.pathname.match(/\/traces\/([a-zA-Z0-9-]+)$/)) {
                      const traceId = url.pathname.split('/').pop();
                      const spans = await dbQuery(db, 'all', `SELECT * FROM traces WHERE trace_id = ?`, [traceId]);
                      sendJson(200, spans);
                  }
                  else if (url.pathname.endsWith('/sessions')) {
                      // sessions has project_id column
                      const sessions = await dbQuery(db, 'all', `SELECT * FROM sessions ${projectFilter} ORDER BY last_activity_time DESC LIMIT 50`, params);
                      // Parse metadata JSON
                      if (sessions) {
                          sessions.forEach(s => { if(s.metadata) s.metadata = JSON.parse(s.metadata); });
                      }
                      sendJson(200, sessions);
                  }
                  else if (url.pathname.endsWith('/projects')) {
                        const projects = await dbQuery(db, 'all', `SELECT DISTINCT project_id FROM traces`);
                        sendJson(200, projects.map(p => p.project_id).filter(Boolean));
                  }
                  else {
                      sendJson(404, { error: 'Unknown endpoint' });
                  }
              } catch (e) {
                  console.error(e);
                  sendJson(500, { error: e.message });
              } finally {
                  db.close();
              }
          };
          
          handleRequest();
          return;
      }

      // --- Config UI Routes (Legacy) ---

      // Serve index.html
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const filePath = path.join(__dirname, 'ui', 'index.html');
        serveStatic(res, filePath, 'text/html; charset=utf-8');
        return;
      }

      // Serve static assets
      if (req.method === 'GET' && !req.url.startsWith('/config')) {
        const possiblePath = path.join(__dirname, 'ui', req.url.substring(1));
        if (fs.existsSync(possiblePath) && fs.lstatSync(possiblePath).isFile()) {
          const ext = path.extname(possiblePath).toLowerCase();
          let contentType = 'text/plain';
          if (ext === '.css') contentType = 'text/css';
          if (ext === '.js') contentType = 'application/javascript';
          if (ext === '.html') contentType = 'text/html';
          
          serveStatic(res, possiblePath, contentType);
          return;
        }
      }

      if (req.method === 'GET' && req.url === '/config') {
        if (fs.existsSync(absConfigPath)) {
          try {
            const raw = fs.readFileSync(absConfigPath, 'utf-8');
            const json = JSON.parse(raw);
            // Optional: validate with RAGConfigSchema if strictly needed, but for UI we might just load it
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(json));
          } catch (e) {
            sendJson(400, { error: e.message });
          }
        } else {
          sendJson(200, DEFAULT_CONFIG);
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            // Clean undefined for JSON payload if present
            const cleanJson = data.config ? JSON.parse(JSON.stringify(data.config)) : null;
            
            // Ensure directory exists
            const dir = path.dirname(absConfigPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            // Write JSON config (for tooling compatibility)
            if (cleanJson) {
              fs.writeFileSync(absConfigPath, JSON.stringify(cleanJson, null, 2), 'utf-8');
            }

            // Write code file if provided
            if (data.code && data.backend) {
              const targetFile = data.backend === 'python' 
                ? path.join(dir, 'vectra_config.py')
                : path.join(dir, 'vectra-config.js');
              fs.writeFileSync(targetFile, String(data.code), 'utf-8');
              sendJson(200, { message: 'Configuration saved successfully!', file: targetFile });
              return;
            }

            sendJson(200, { message: 'Configuration saved successfully!' });
          } catch (e) {
            sendJson(400, { error: e.message });
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.log(`Port ${currentPort} is in use, trying ${currentPort + 1}...`);
        if (currentPort + 1 > 65535) {
            console.error("No available ports found.");
            return;
        }
        // Try next port with a new server instance
        createServer(currentPort + 1);
      } else {
        throw e;
      }
    });

    server.listen(currentPort, () => {
      let url = `http://localhost:${currentPort}/`;
      if (mode === 'dashboard') {
        url = `http://localhost:${currentPort}/dashboard`;
      }
      console.log(`Vectra WebConfig running at ${url}`);
      if (openInBrowser) {
        openBrowser(url);
      }
    });
  };

  createServer(port);
}

module.exports = { start };
