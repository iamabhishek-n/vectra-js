const SQLiteLogger = require('./src/observability');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = 'test_traces_js.db';
if (fs.existsSync(DB_PATH)) {
    try {
        fs.unlinkSync(DB_PATH);
    } catch (e) {
        console.log('Could not unlink db, might be open.');
    }
}

const config = {
    enabled: true,
    sqlitePath: DB_PATH,
    projectId: 'test-project-js',
    trackTraces: true,
    trackMetrics: false,
    trackLogs: false,
    sessionTracking: false
};

const logger = new SQLiteLogger(config);

// Give it a moment to initialize schema
setTimeout(() => {
    logger.logTrace({
        traceId: 'trace-js-1',
        spanId: 'span-js-1',
        name: 'test-span-js',
        startTime: Date.now(),
        endTime: Date.now() + 100,
        provider: 'anthropic',
        modelName: 'claude-3-opus'
    });

    setTimeout(() => {
        const db = new sqlite3.Database(DB_PATH);
        db.get("SELECT * FROM traces WHERE trace_id = 'trace-js-1'", (err, row) => {
            if (err) {
                console.error('Error fetching trace:', err);
                return;
            }
            console.log('Trace found:', row);

            if (row && row.provider === 'anthropic' && row.model_name === 'claude-3-opus') {
                console.log('Provider and Model Name verification passed!');
            } else {
                console.log('Verification failed:', row);
            }
            db.close();
        });
    }, 1000);
}, 500);
