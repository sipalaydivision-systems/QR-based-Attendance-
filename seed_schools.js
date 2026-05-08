const db = require('./config/database');

const schools = [
    'Agripino Alvarez Elementary School',
    'Banag Elementary School',
    'Barangay V Elementary School',
    'Barasbarasan Elementary School',
    'Bawog Elementary School',
    'Binotusan Elementary School',
    'Binulig Elementary School',
    'Bungabunga Elementary School',
    'Cabadiangan Elementary School',
    'Calangcang Elementary School',
    'Calat-an Elementary School',
    'Cambogui-ot Elementary School',
    'Cambogui-ot National High School',
    'Camindangan Elementary School',
    'Camindangan National High School',
    'Cansauro Elementary School',
    'Cantaca Elementary School',
    'Canturay Elementary School',
    'Cartagena Elementary School',
    'Cayhagan Elementary School',
    'Cayhagan National High School',
    'Crossing Tanduay Elementary School',
    'Dung-i Integrated School',
    'Dungga Integrated School',
    'Genaro P. Alvarez Elementary School',
    'Genaro P. Alvarez Elementary School II',
    'Gil M. Montilla Elementary School',
    'Gil Montilla National High School',
    'Hda. Maricalum Elementary School',
    'Jacinto Montilla Memorial National High School',
    'Leodegario Ponce Gonzales National High School',
    'Macarandan Integrated School',
    'Manlucahoc Elementary School',
    'Mariano Gemora National High School',
    'Maricalum Elementary School',
    'Maricalum Farm School',
    'Mauboy Integrated School',
    'Nabulao Elementary School',
    'Nabulao National High School',
    'Nauhang Primary School',
    'Omas Integrated School',
    'Patag Magbanua Elementary School',
    'Sipalay City National High School',
    'Tugas Integrated School',
    'Vista Alegre Integrated School'
];

(async () => {
    let added = 0, skipped = 0;
    for (const name of schools) {
        const [existing] = await db.query('SELECT id FROM schools WHERE name = ?', [name]);
        if (existing.length > 0) { skipped++; continue; }

        const initials = name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 6);
        const [ex] = await db.query('SELECT COUNT(*) as cnt FROM schools WHERE school_code LIKE ?', [initials + '%']);
        const code = initials + '-' + String(ex[0].cnt + 1).padStart(3, '0');

        await db.query('INSERT INTO schools (name, school_code) VALUES (?, ?)', [name, code]);
        console.log('+', name, '->', code);
        added++;
    }
    console.log(`\nDone: ${added} added, ${skipped} skipped (already exist)`);
    process.exit();
})();
