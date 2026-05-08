// Seed script - creates default admin user
// Run: node database/seed.js

require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../config/database');

async function seed() {
    try {
        console.log('Seeding database...');

        // Create default super admin
        const password = await bcrypt.hash('admin123', 10);
        await db.query(
            `INSERT INTO users (username, password, fullname, email, role)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE password = ?`,
            ['admin', password, 'System Administrator', 'admin@system.local', 'super_admin', password]
        );
        console.log('Default admin created: username=admin, password=admin123');

        // Create sample school
        const [schoolResult] = await db.query(
            `INSERT INTO schools (name, address) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name)`,
            ['Sample Elementary School', '123 Main Street']
        );
        const schoolId = schoolResult.insertId || 1;
        console.log('Sample school created.');

        // Create sample grade levels
        const grades = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];
        for (const grade of grades) {
            await db.query(
                'INSERT IGNORE INTO grade_levels (name, school_id) VALUES (?, ?)',
                [grade, schoolId]
            );
        }
        console.log('Grade levels created.');

        console.log('Seed complete!');
        process.exit(0);
    } catch (err) {
        console.error('Seed error:', err);
        process.exit(1);
    }
}

seed();
