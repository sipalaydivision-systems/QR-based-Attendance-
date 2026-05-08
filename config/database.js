const mysql = require('mysql2/promise');

const isProduction = process.env.NODE_ENV === 'production';
const getEnv = (primary, railway, fallback) => process.env[primary] || process.env[railway] || fallback;

const dbConfig = {
    host: getEnv('DB_HOST', 'MYSQLHOST', isProduction ? undefined : 'localhost'),
    user: getEnv('DB_USER', 'MYSQLUSER', isProduction ? undefined : 'root'),
    password: getEnv('DB_PASS', 'MYSQLPASSWORD', isProduction ? undefined : ''),
    database: getEnv('DB_NAME', 'MYSQLDATABASE', isProduction ? undefined : 'qr_attend'),
    port: parseInt(getEnv('DB_PORT', 'MYSQLPORT', isProduction ? undefined : '3306'), 10)
};

if (isProduction) {
    const required = ['host', 'user', 'database', 'port'];
    const missing = required.filter((key) => !dbConfig[key]);

    if (!dbConfig.password && !process.env.DB_PASS && !process.env.MYSQLPASSWORD) {
        missing.push('password');
    }

    if (missing.length > 0) {
        throw new Error(`Missing MySQL database configuration: ${missing.join(', ')}`);
    }
}

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

module.exports = pool;
