// Seed script - creates default admin user
// Run: node database/seed.js

require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../config/database');

async function seed() {
    try {
        console.log('Seeding database...');

        // Create default super admin only when it does not already exist.
        const password = await bcrypt.hash('admin123', 10);
        await db.query(
            `INSERT INTO users (username, password, fullname, email, role)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE username = username`,
            ['admin', password, 'System Administrator', 'admin@system.local', 'super_admin']
        );
        console.log('Default admin created: username=admin, password=admin123');

        const [[schoolCount]] = await db.query('SELECT COUNT(*) AS count FROM schools');
        if (schoolCount.count === 0) {
            const [schoolResult] = await db.query(
                'INSERT INTO schools (name, address) VALUES (?, ?)',
                ['Sample Elementary School', '123 Main Street']
            );
            const schoolId = schoolResult.insertId;
            console.log('Sample school created.');

            const grades = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];
            for (const grade of grades) {
                await db.query(
                    'INSERT INTO grade_levels (name, school_id) VALUES (?, ?)',
                    [grade, schoolId]
                );
            }
            console.log('Grade levels created.');
        }

        console.log('Seed complete!');
        process.exit(0);
    } catch (err) {
        console.error('Seed error:', err);
        process.exit(1);
    }
}

seed();
