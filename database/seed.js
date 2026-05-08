// Seed script - creates default admin user
// Run: node database/seed.js

require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../config/database');

const sipalaySchools = [
    ['Agripino Elementary School', '117348', 'Sipalay City, Negros Occidental'],
    ['Banag Elementary School', '117349', 'Sipalay City, Negros Occidental'],
    ['Barangay V Elementary School', '117350', 'Brgy. 5, Sipalay City, Negros Occidental'],
    ['Barasbarasan Elementary School', '117365', 'Sipalay City, Negros Occidental'],
    ['Bawog Elementary School', '117366', 'Sipalay City, Negros Occidental'],
    ['Binotusan Elementary School', '180506', 'Sipalay City, Negros Occidental'],
    ['Binulig Elementary School', '117367', 'Brgy. Binulig, Sipalay City'],
    ['Bunga-Bunga Elementary School', '117368', 'Sipalay City, Negros Occidental'],
    ['Cabadiangan Elementary School', '117351', 'Brgy. Cabadiangan, Sipalay City'],
    ['Calangcang Elementary School', '117352', 'Sipalay City, Negros Occidental'],
    ['Calat-an Elementary School', '117369', 'Sipalay City, Negros Occidental'],
    ['Cambogui-ot Elementary School', '117370', 'Brgy. Cambugot, Sipalay City'],
    ['Camindangan Elementary School', '117371', 'Brgy. Camindangan, Sipalay City'],
    ['Cansauro Elementary School', '117353', 'Sipalay City, Negros Occidental'],
    ['Cantaca Elementary School', '117354', 'Sipalay City, Negros Occidental'],
    ['Canturay Elementary School', '117372', 'Brgy. Canturay, Sipalay City'],
    ['Cartagena Elementary School', '117373', 'Sipalay City, Negros Occidental'],
    ['Cayhagan Elementary School', '117355', 'Brgy. Cayhagan, Sipalay City'],
    ['Crossing Tanduay Elementary School', '117374', 'Sipalay City, Negros Occidental'],
    ['Dungga Elementary School', '117356', 'Sipalay City, Negros Occidental'],
    ['Genaro P. Alvarez Elementary School', '117357', 'Sipalay City, Negros Occidental'],
    ['Genaro P. Alvarez Elementary School II', '117375', 'Sipalay City, Negros Occidental'],
    ['Gil Montilla Elementary School', '117358', 'Sipalay City, Negros Occidental'],
    ['Hda. Maricalum Elementary School', '117359', 'Brgy. Maricalum, Sipalay City'],
    ['Macarandan Elementary School', '117376', 'Sipalay City, Negros Occidental'],
    ['Manlucahoc Elementary School', '117377', 'Brgy. Manlucahoc, Sipalay City'],
    ['Maricalum Elementary School', '117360', 'Brgy. Maricalum, Sipalay City'],
    ['Nabulao Elementary School', '117362', 'Brgy. Nabulao, Sipalay City'],
    ['Nauhang Primary School', '117364', 'Brgy. Nauhang, Sipalay City'],
    ['Patag Magbanua Elementary School', '117378', 'Sipalay City, Negros Occidental'],
    ['Cambogui-ot National High School', '306247', 'Brgy. Cambugot, Sipalay City'],
    ['Camindangan National High School', '302636', 'Brgy. Camindangan, Sipalay City'],
    ['Cayhagan National High School', '302665', 'Brgy. Cayhagan, Sipalay City'],
    ['Gil Montilla National High School', '302632', 'Sipalay City, Negros Occidental'],
    ['Gil Montilla NHS - Cabadiangan Extension', '302635', 'Brgy. Cabadiangan, Sipalay City'],
    ['Gil Montilla NHS - Binulig Extension', '302634', 'Brgy. Binulig, Sipalay City'],
    ['Gil Montilla NHS - Crossing Tanduay Extension', '302639', 'Sipalay City, Negros Occidental'],
    ['Gil Montilla NHS - Manlucahoc Extension', '302640', 'Brgy. Manlucahoc, Sipalay City'],
    ['Jacinto Montilla Memorial National High School', '302637', 'Sipalay City, Negros Occidental'],
    ['Mariano Gemora National High School', '302638', 'Sipalay City, Negros Occidental'],
    ['Maricalum Farm School', '302666', 'Brgy. Maricalum, Sipalay City'],
    ['Nabulao National High School', '302664', 'Brgy. Nabulao, Sipalay City'],
    ['Sipalay City National High School', '302633', 'Sipalay City, Negros Occidental'],
    ['Dung-i Integrated School', '502571', 'Sipalay City, Negros Occidental'],
    ['Mauboy Integrated School', '502576', 'Sipalay City, Negros Occidental'],
    ['Omas Integrated School', '502573', 'Sipalay City, Negros Occidental'],
    ['Tugas Integrated School', '501802', 'Sipalay City, Negros Occidental'],
    ['Vista Alegre Integrated School', '502575', 'Sipalay City, Negros Occidental']
];

function makeSchoolCode(name, index) {
    const initials = name
        .split(/\s+/)
        .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
        .filter(Boolean)
        .map((word) => word[0])
        .join('')
        .toUpperCase()
        .slice(0, 6);

    return `${initials}-${String(index + 1).padStart(3, '0')}`;
}

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

        const [[sampleDeps]] = await db.query(
            `SELECT
                (SELECT COUNT(*) FROM students st JOIN schools sc ON st.school_id = sc.id WHERE sc.name = ?) +
                (SELECT COUNT(*) FROM teachers t JOIN schools sc ON t.school_id = sc.id WHERE sc.name = ?) AS count`,
            ['Sample Elementary School', 'Sample Elementary School']
        );
        if (sampleDeps.count === 0) {
            await db.query('DELETE FROM grade_levels WHERE school_id IN (SELECT id FROM schools WHERE name = ?)', ['Sample Elementary School']);
            await db.query('DELETE FROM schools WHERE name = ?', ['Sample Elementary School']);
        }

        let seededSchools = 0;
        for (let i = 0; i < sipalaySchools.length; i++) {
            const [name, schoolIdCode, address] = sipalaySchools[i];
            await db.query(
                `INSERT INTO schools (name, school_id_code, school_code, address, status)
                 VALUES (?, ?, ?, ?, 'active')
                 ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    school_id_code = VALUES(school_id_code),
                    address = VALUES(address),
                    status = 'active'`,
                [name, schoolIdCode, makeSchoolCode(name, i), address]
            );
            seededSchools++;
        }
        console.log(`Sipalay schools seeded: ${seededSchools}`);

        console.log('Seed complete!');
        process.exit(0);
    } catch (err) {
        console.error('Seed error:', err);
        process.exit(1);
    }
}

seed();
