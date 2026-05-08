require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../config/database');

async function ensureColumn(tableName, columnName, definition) {
    const [columns] = await db.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [tableName, columnName]
    );

    if (columns.length === 0) {
        console.log(`Adding missing column ${tableName}.${columnName}...`);
        await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
}

async function init() {
    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        const statements = schema
            .split(';')
            .map((statement) => statement.trim())
            .filter(Boolean);

        console.log('Initializing MySQL schema...');
        for (const statement of statements) {
            await db.query(statement);
        }

        await ensureColumn('schools', 'school_id_code', 'VARCHAR(50) UNIQUE AFTER name');
        await ensureColumn('users', 'last_login', 'TIMESTAMP NULL AFTER status');

        console.log('Running database seed...');
        require('./seed');
    } catch (err) {
        console.error('Database initialization failed:', err);
        process.exit(1);
    }
}

init();
