const db = require('../config/database');

(async () => {
    await db.query("ALTER TABLE students MODIFY COLUMN status ENUM('active','inactive','deleted') DEFAULT 'active'");
    console.log('students ENUM updated');
    await db.query("ALTER TABLE teachers MODIFY COLUMN status ENUM('active','inactive','deleted') DEFAULT 'active'");
    console.log('teachers ENUM updated');
    process.exit(0);
})();
