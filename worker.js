// worker.js

let db;
let sqlite3;

// --- SYSTEM INITIALIZATION ---
(async function init() {
    try {
        postMessage({ type: 'log', msg: '⏳ Downloading SQLite WASM engine...' });
        importScripts('sqlite3.js'); 
        
        postMessage({ type: 'log', msg: '⏳ Initializing WASM module...' });
        
        // 🛠️ CONFIGURACIÓN EXPLÍCITA DEL PROXY OPFS
        sqlite3 = await self.sqlite3InitModule({
            print: console.log,
            printErr: console.error,
            // Indicamos explícitamente el nombre del proxy que subiste a GitHub
            locateFile: (path) => {
                return path;
            }
        });
        
        if ('opfs' in sqlite3) {
            db = new sqlite3.oo1.OpfsDb('/visor_csv_masivo.sqlite3');
            postMessage({ type: 'log', msg: '✅ Database mounted on disk (OPFS).' });
        } else {
            // Vamos a forzar un intento de inicialización manual si sqlite3.oo1 tiene métodos de OPFS alternativos
            try {
                postMessage({ type: 'log', msg: '⚠️ OPFS property not found. Trying manual OPFS binding...' });
                // En algunas versiones el OPFS requiere una inicialización asíncrona explícita
                db = new sqlite3.oo1.OpfsDb('/visor_csv_masivo.sqlite3');
                postMessage({ type: 'log', msg: '✅ Database mounted on disk (OPFS forced).' });
            } catch (innerErr) {
                postMessage({ type: 'log', msg: '⚠️ Manual OPFS failed: ' + innerErr.message + '. Falling back to RAM.' });
                db = new sqlite3.oo1.DB('/visor_csv_masivo.sqlite3', 'ct');
            }
        }
        postMessage({ type: 'ready' });
    } catch (err) {
        postMessage({ type: 'error', msg: 'Failed to start SQLite: ' + err.message });
    }
})();

// --- MESSAGE RECEPTION FROM UI ---
self.onmessage = async function(e) {
    const { action, payload } = e.data;
    if (!db) return;
    try {
        if (action === 'analyze_file') {
            const file = payload;
            const fileSize = file.size; // Extract the original File object size
            
            postMessage({ type: 'log', msg: 'Sampling file to detect structure...' });
            
            const sampleLines = await getCSVSample(file, 100);
            
            // Detect delimiter
            const delimiter = detectDelimiter(sampleLines);
            let delimiterName = delimiter === '\t' ? 'Tab (\\t)' : delimiter;
            postMessage({ type: 'log', msg: `🔍 Automatic delimiter detected: [ ${delimiterName} ]` });

            const schema = analyzeSample(sampleLines, delimiter);
            
            postMessage({ type: 'log', msg: `Schema detected. Columns: ${schema.columns.length}, Header: ${schema.hasHeader ? 'Yes' : 'No'}` });
            
            createTable(schema);
            postMessage({ type: 'schema_ready', data: schema });
            
            await startMassiveImport(file, schema, fileSize, delimiter);
        }
        if (action === 'query_data') handleQuery(payload);
        if (action === 'get_distinct') handleDistinct(payload);
    } catch (error) {
        postMessage({ type: 'error', msg: error.message });
    }
};

// ==========================================
// CORE FUNCTIONS (Reading and Analysis)
// ==========================================

// Expert parser to handle commas inside quotes (typical in CRMs)
function parseCSVLine(text, separator = ',') {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (inQuotes && text[i + 1] === '"') {
                current += '"'; 
                i++;
            } else {
                inQuotes = !inQuotes; 
            }
        } else if (char === separator && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

// Heuristic function to discover the delimiter
function detectDelimiter(lines) {
    if (!lines || lines.length === 0) return ',';
    
    const candidates = [',', ';', '\t', '|', '¦'];
    let bestDelimiter = ',';
    let maxCols = 1;

    // Evaluate the first 10 lines to ensure consistency
    const sampleSize = Math.min(lines.length, 10);
    
    for (const sep of candidates) {
        let isConsistent = true;
        // Try parsing row 0 with the current candidate
        let firstRowCount = parseCSVLine(lines[0], sep).length;
        
        // If it didn't split anything, ignore this candidate
        if (firstRowCount <= 1) continue;
        
        // Check if the rest of the rows maintain the same number of columns
        for (let i = 1; i < sampleSize; i++) {
            if (parseCSVLine(lines[i], sep).length !== firstRowCount) {
                isConsistent = false;
                break;
            }
        }

        // If consistent and has more columns than the current winner, replace it
        if (isConsistent && firstRowCount > maxCols) {
            maxCols = firstRowCount;
            bestDelimiter = sep;
        }
    }
    
    // Fallback: If the file is so broken that none is consistent,
    // keep the one that achieves the most separations in row 0.
    if (maxCols === 1) {
        for (const sep of candidates) {
            let count = parseCSVLine(lines[0], sep).length;
            if (count > maxCols) {
                maxCols = count;
                bestDelimiter = sep;
            }
        }
    }

    return bestDelimiter;
}

// Read a portion from the beginning of the file
async function getCSVSample(file, maxLines) {
    const stream = file.stream().pipeThrough(new TextDecoderStream());
    const reader = stream.getReader();
    let buffer = '';
    const lines = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop();
        for (const line of parts) {
            if (line.trim() !== '') lines.push(line);
            if (lines.length >= maxLines) {
                reader.cancel();
                return lines;
            }
        }
    }
    if (buffer.trim() !== '') lines.push(buffer);
    return lines;
}

// Advanced heuristics to determine column types and if a header exists
function analyzeSample(lines, delimiter) {
    if (lines.length === 0) throw new Error("The CSV file is empty.");
    
    const rows = lines.map(line => parseCSVLine(line, delimiter));
    const numCols = rows[0].length;

    const inferType = (val) => {
        if (val === '') return 'NULL';
        if (/^(true|false|1|0)$/i.test(val)) return 'BOOLEAN';
        if (/^-?\d+$/.test(val)) return 'INTEGER';
        if (/^-?\d+\.\d+$/.test(val)) return 'REAL';
        if (/^\d{4}-\d{2}-\d{2}/.test(val)) return 'TEXT_DATE'; 
        return 'TEXT';
    };

    const row0Types = rows[0].map(inferType);
    const dataTypes = new Array(numCols).fill('INTEGER');
    
    let stringCountRow0 = 0;
    let camelCaseOrUnderscoreCountRow0 = 0;
    let differentTypeCount = 0;

    for (let j = 0; j < numCols; j++) {
        if (row0Types[j] === 'TEXT') stringCountRow0++;
        // Detect common database formats like Billing_City or customerId
        if (/^[a-zA-Z0-9_]+$/.test(rows[0][j]) && (rows[0][j].includes('_') || /^[A-Z][a-z]+[A-Z]/.test(rows[0][j]))) {
            camelCaseOrUnderscoreCountRow0++;
        }
    }

    for (let i = 1; i < rows.length; i++) {
        for (let j = 0; j < numCols; j++) {
            const currentType = dataTypes[j];
            const cellType = inferType(rows[i][j]);
            if (cellType === 'NULL') continue;
            
            if (currentType === 'INTEGER' && cellType === 'REAL') dataTypes[j] = 'REAL';
            else if (cellType === 'TEXT' || cellType === 'TEXT_DATE') dataTypes[j] = 'TEXT';
            else if (cellType === 'BOOLEAN' && currentType !== 'TEXT') dataTypes[j] = 'BOOLEAN';
        }
    }

    for (let j = 0; j < numCols; j++) {
        if (row0Types[j] === 'TEXT' && (dataTypes[j] === 'INTEGER' || dataTypes[j] === 'REAL' || dataTypes[j] === 'BOOLEAN' || dataTypes[j] === 'TEXT_DATE')) {
            differentTypeCount++;
        }
    }

    let hasHeader = false;
    if (stringCountRow0 === numCols && differentTypeCount > 0) hasHeader = true;
    if (camelCaseOrUnderscoreCountRow0 > (numCols * 0.3)) hasHeader = true;

    const emptyRow1Count = rows[1] ? rows[1].filter(v => v === '').length : 0;
    const emptyRow0Count = rows[0].filter(v => v === '').length;
    if (emptyRow0Count === 0 && emptyRow1Count > (numCols * 0.2)) hasHeader = true;

    let headers = [];
    if (hasHeader) {
        headers = rows[0].map((h, i) => {
            let cleanH = h.replace(/[^a-zA-Z0-9_]/g, '');
            if (/^\d/.test(cleanH) || cleanH === '') cleanH = `col_${i}`;
            return cleanH;
        });
    } else {
        headers = Array.from({length: numCols}, (_, i) => `col_${i}`);
        row0Types.forEach((t, j) => {
            if (t === 'TEXT' || (t === 'REAL' && dataTypes[j] === 'INTEGER')) dataTypes[j] = 'TEXT';
        });
    }

    const mapToSqlite = (type) => {
        if (type === 'BOOLEAN' || type === 'TEXT_DATE' || type === 'NULL') return 'TEXT';
        return type;
    };

    return {
        hasHeader,
        columns: headers.map((name, i) => ({
            name: name,
            sqliteType: mapToSqlite(dataTypes[i])
        }))
    };
}

function createTable(schema) {
    db.exec(`DROP TABLE IF EXISTS csv_data;`);
    const createCols = schema.columns.map(c => `${c.name} ${c.sqliteType}`).join(', ');
    db.exec(`CREATE TABLE csv_data (csvv_internal_id INTEGER PRIMARY KEY AUTOINCREMENT, ${createCols});`);
}

// ==========================================
// MASSIVE IMPORT
// ==========================================

async function startMassiveImport(file, schema, fileSize, delimiter) {
    postMessage({ type: 'log', msg: '🚀 Starting massive import...' });
    
    const stream = file.stream().pipeThrough(new TextDecoderStream());
    const reader = stream.getReader();
    
    let buffer = '';
    let isFirstLine = true;
    let totalInserted = 0;
    
    let charsProcessed = 0; 
    const estimatedTotalChars = fileSize || 1; // Avoid division by zero
    
    const BATCH_SIZE = 5000;
    let batchValues = [];

    const colNames = schema.columns.map(c => c.name).join(', ');
    const placeholders = schema.columns.map(() => '?').join(', ');
    const insertSQL = `INSERT INTO csv_data (${colNames}) VALUES (${placeholders})`;
    
    let stmt;

    const flushBatch = async () => {
        if (batchValues.length === 0) return;
        db.exec('BEGIN TRANSACTION;');
        stmt = db.prepare(insertSQL);
        
        for (const row of batchValues) {
            const paddedRow = Array(schema.columns.length).fill(null);
            for (let i = 0; i < Math.min(row.length, schema.columns.length); i++) {
                paddedRow[i] = row[i] || null;
            }
            stmt.bind(paddedRow).step();
            stmt.reset();
        }
        
        stmt.finalize();
        db.exec('COMMIT;');
        
        totalInserted += batchValues.length;
        batchValues = [];
        
        let percent = (charsProcessed / estimatedTotalChars) * 100;
        if (percent > 99.9 && charsProcessed < estimatedTotalChars) percent = 99.9; 
        if (percent > 100) percent = 100;

        // 🛠️ SHOW PROGRESS DIRECTLY IN THE LOG
        postMessage({ 
            type: 'log', 
            msg: `⚙️ Imported ${totalInserted.toLocaleString()} rows. ${percent.toFixed(1)}% completed.` 
        });
        
        // Yield the thread briefly so the HTML console can repaint
        await new Promise(resolve => setTimeout(resolve, 0));
    };

    while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        charsProcessed += value.length; 
        buffer += value;
        
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop();
        
        for (const line of parts) {
            if (line.trim() === '') continue;
            
            if (isFirstLine && schema.hasHeader) {
                isFirstLine = false;
                continue;
            }
            isFirstLine = false;

            batchValues.push(parseCSVLine(line, delimiter));

            if (batchValues.length >= BATCH_SIZE) {
                await flushBatch();
            }
        }
    }
    
    if (buffer.trim() !== '') {
        batchValues.push(parseCSVLine(buffer, delimiter));
    }
    
    charsProcessed = estimatedTotalChars; 
    await flushBatch();

    postMessage({ type: 'log', msg: `✅ Import 100% completed. Total: ${totalInserted.toLocaleString()} records.` });
    postMessage({ type: 'import_done' });
}

// ==========================================
// SQL QUERIES
// ==========================================

function handleQuery(payload) {
    const { column, value, limit, offset, sortCol, sortOrder } = payload;
    let whereClause = '';
    let bindArgs = [];
    
    if (value && value.trim() !== '') {
        whereClause = ` WHERE ${column} LIKE ?`;
        bindArgs.push(`%${value}%`);
    }

    let total = 0;
    db.exec({
        sql: `SELECT COUNT(*) as count FROM csv_data` + whereClause,
        bind: bindArgs,
        rowMode: 'object',
        callback: function(row) { total = row.count; }
    });

    let orderClause = 'ORDER BY csvv_internal_id ASC';
    if (sortCol && sortOrder !== 'NONE') {
        orderClause = `ORDER BY ${sortCol} ${sortOrder}, csvv_internal_id ASC`;
    }

    const sql = `SELECT * FROM csv_data ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
    const dataBindArgs = [...bindArgs, limit, offset];
    
    const rows = [];
    db.exec({
        sql: sql,
        bind: dataBindArgs,
        rowMode: 'object',
        callback: function(row) { rows.push(row); }
    });
    
    postMessage({ type: 'query_result', data: { rows: rows, total: total } });
}

function handleDistinct(payload) {
    const { column } = payload;
    const sql = `SELECT DISTINCT ${column} AS val FROM csv_data WHERE ${column} IS NOT NULL LIMIT 101`;
    const rows = [];
    db.exec({
        sql: sql,
        rowMode: 'object',
        callback: function(row) { rows.push(row.val); }
    });

    if (rows.length > 100) {
        postMessage({ type: 'distinct_result', data: { error: `Column '${column}' has more than 100 distinct values.` } });
    } else {
        postMessage({ type: 'distinct_result', data: { values: rows } });
    }
}