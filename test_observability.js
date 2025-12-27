const SQLiteLogger = require('./src/observability');
const fs = require('fs');

const DB_PATH = 'test_traces.db';
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const config = {
    enabled: true,
    sqlitePath: DB_PATH,
    projectId: 'test-project',
    trackTraces: true
};

const logger = new SQLiteLogger(config);

logger.logTrace({
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'test-span',
    startTime: Date.now(),
    endTime: Date.now() + 100,
    provider: 'openai',
    modelName: 'gpt-4'
});

setTimeout(() => {
    // Note: The observability.js uses 'sqlite3', but here we use 'better-sqlite3' for verification if available,
    // or we can use sqlite3 to read it back. Since the project uses sqlite3 in observability.js, let's stick to that if possible,
    // OR just use better-sqlite3 if it's installed.
    // However, the error log showed "SQLiteLogger is not a constructor", which was due to destructuring import.
    // Let's try to use sqlite3 for verification as well to be safe, or check what's installed.
    
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(DB_PATH);
    
    db.get('SELECT * FROM traces WHERE trace_id = ?', ['trace-1'], (err, row) => {
        if (err) {
            console.error('Error reading DB:', err);
            return;
        }
        console.log('Trace found:', row);
        
        if (row && row.provider === 'openai' && row.model_name === 'gpt-4') {
            console.log('Provider and Model Name verification passed!');
        } else {
            console.error('Verification failed:', row);
        }
        
        db.close();
        // fs.unlinkSync(DB_PATH); // Keep it for inspection if needed, or delete
    });
}, 1000);
