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

async function ensureColumnDefinition(tableName, columnName, definition) {
    const [columns] = await db.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [tableName, columnName]
    );

    if (columns.length > 0) {
        console.log(`Ensuring column definition ${tableName}.${columnName}...`);
        await db.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${definition}`);
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
        await ensureColumn('teachers', 'contact', 'VARCHAR(100) AFTER subject');
        await ensureColumn('teachers', 'email', 'VARCHAR(255) AFTER contact');
        await ensureColumn('teachers', 'grade_level_id', 'INT NULL AFTER email');
        await ensureColumn('teachers', 'section_id', 'INT NULL AFTER grade_level_id');
        await ensureColumn('teachers', 'active_from', 'DATE NULL AFTER qr_code');
        await ensureColumn('sections', 'adviser_teacher_id', 'INT NULL AFTER adviser');
        await ensureColumn('students', 'active_from', 'DATE NULL AFTER qr_code');
        await ensureColumnDefinition('users', 'role', "ENUM('super_admin','principal','superintendent','asst_superintendent','adviser','parent') NOT NULL DEFAULT 'principal'");
        await ensureColumnDefinition('students', 'status', "ENUM('active','inactive','deleted') DEFAULT 'inactive'");
        await ensureColumnDefinition('teachers', 'status', "ENUM('active','inactive','deleted') DEFAULT 'inactive'");
        await ensureColumnDefinition('attendance', 'status', "ENUM('present','late','half_day','absent') DEFAULT 'present'");
        await ensureColumnDefinition('schools', 'logo', 'MEDIUMTEXT');
        await ensureColumnDefinition('settings', 'setting_value', 'MEDIUMTEXT');

        const [inactiveResult] = await db.query(`
            UPDATE students s
            SET s.status = 'inactive',
                s.active_from = NULL
            WHERE s.status = 'active'
              AND NOT EXISTS (
                  SELECT 1
                  FROM attendance a
                  WHERE a.person_type = 'student'
                    AND a.person_id = s.id
                    AND a.time_in IS NOT NULL
              )
        `);
        if (inactiveResult.affectedRows) {
            console.log(`Marked ${inactiveResult.affectedRows} student(s) without attendance history as inactive.`);
        }

        const [inactiveTeachersResult] = await db.query(`
            UPDATE teachers t
            SET t.status = 'inactive',
                t.active_from = NULL
            WHERE t.status = 'active'
              AND NOT EXISTS (
                  SELECT 1
                  FROM attendance a
                  WHERE a.person_type = 'teacher'
                    AND a.person_id = t.id
                    AND a.time_in IS NOT NULL
              )
        `);
        if (inactiveTeachersResult.affectedRows) {
            console.log(`Marked ${inactiveTeachersResult.affectedRows} teacher(s) without attendance history as inactive.`);
        }

        console.log('Running database seed...');
        require('./seed');
    } catch (err) {
        console.error('Database initialization failed:', err);
        process.exit(1);
    }
}

init();
