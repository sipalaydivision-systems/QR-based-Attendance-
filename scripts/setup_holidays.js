const db = require('../config/database');

(async () => {
    try {
        // Create holidays table
        await db.query(`
            CREATE TABLE IF NOT EXISTS holidays (
                id INT AUTO_INCREMENT PRIMARY KEY,
                holiday_date DATE NOT NULL,
                name VARCHAR(255) NOT NULL,
                school_id INT DEFAULT NULL,
                is_national TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_holiday (holiday_date, school_id),
                INDEX idx_holiday_date (holiday_date),
                FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
        console.log('holidays table created');

        // Seed 2026 Philippine national holidays
        const holidays = [
            ['2026-01-01', "New Year's Day"],
            ['2026-02-25', 'EDSA People Power Revolution Anniversary'],
            ['2026-04-02', 'Maundy Thursday'],
            ['2026-04-03', 'Good Friday'],
            ['2026-04-04', 'Black Saturday'],
            ['2026-04-09', 'Araw ng Kagitingan'],
            ['2026-05-01', 'Labor Day'],
            ['2026-06-12', 'Independence Day'],
            ['2026-08-21', 'Ninoy Aquino Day'],
            ['2026-08-31', 'National Heroes Day'],
            ['2026-11-01', "All Saints' Day"],
            ['2026-11-02', "All Souls' Day"],
            ['2026-11-30', 'Bonifacio Day'],
            ['2026-12-24', 'Christmas Eve'],
            ['2026-12-25', 'Christmas Day'],
            ['2026-12-30', 'Rizal Day'],
            ['2026-12-31', "New Year's Eve"]
        ];

        for (const [d, n] of holidays) {
            await db.query(
                'INSERT IGNORE INTO holidays (holiday_date, name, is_national) VALUES (?, ?, 1)',
                [d, n]
            );
        }
        console.log('PH holidays 2026 seeded: ' + holidays.length + ' entries');
        process.exit(0);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
})();
