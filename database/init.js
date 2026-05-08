require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../config/database');

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

        console.log('Running database seed...');
        require('./seed');
    } catch (err) {
        console.error('Database initialization failed:', err);
        process.exit(1);
    }
}

init();
