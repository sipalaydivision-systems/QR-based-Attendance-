require('dotenv').config();
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./config/database');
const MySQLSessionStore = require('./config/mysqlSessionStore');
const { getScannerKioskToken } = require('./utils/scannerKiosk');
const { todayDate, currentMonth, nowIso } = require('./utils/appTime');
const { firebasePushStatus } = require('./utils/firebasePush');
const { startSystemPushScheduler } = require('./utils/systemPushScheduler');
const { trackSystemTraffic } = require('./utils/systemTrafficMetrics');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Railway waits for this response before switching traffic from the previous
// deployment, preventing the short 502 window mobile users previously saw.
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'healthy' });
});

if (isProduction) {
    app.set('trust proxy', 1);
}

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(compression({ threshold: 1024 }));
app.use(trackSystemTraffic);

function settingImageUrl(asset, value) {
    if (!value) return '';
    const version = crypto.createHash('md5').update(String(value)).digest('hex').slice(0, 12);
    return `/brand/${asset}-image?v=${version}`;
}

function serveSettingImage(settingKey) {
    return async (_req, res) => {
        try {
            const [[row]] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [settingKey]);
            const value = String(row?.setting_value || '').trim();
            if (!value) return res.status(404).end();
            const dataUrl = value.match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,(.+)$/i);
            if (dataUrl) {
                const bytes = Buffer.from(dataUrl[2], 'base64');
                res.set('Content-Type', dataUrl[1].toLowerCase());
                res.set('Cache-Control', 'public, max-age=31536000, immutable');
                res.set('ETag', `"${crypto.createHash('md5').update(bytes).digest('hex')}"`);
                return res.send(bytes);
            }
            if (value.startsWith('/') || /^https?:\/\//i.test(value)) {
                res.set('Cache-Control', 'public, max-age=3600');
                return res.redirect(302, value);
            }
            return res.status(404).end();
        } catch (err) {
            console.error('Brand image error:', err);
            return res.status(500).end();
        }
    };
}

app.get('/brand/system-logo-image', serveSettingImage('system_logo'));
app.get('/brand/school-art-image', serveSettingImage('mobile_dashboard_school_art'));

const DESKTOP_SCANNER_LATEST = {
    version: '1.0.33',
    notes: 'Pushes school calendar and class suspension updates to active desktop scanners faster.'
};

const MOBILE_APP_LATEST = {
    version: '2.1.48',
    version_code: 79,
    notes: 'Faster SDS/ASDS loading, cached reconnect recovery, and 90% less fallback dashboard polling while Firebase alerts remain immediate.'
};

function mobileApkReleaseUrl() {
    const version = MOBILE_APP_LATEST.version;
    return `https://github.com/sipalaydivision-systems/QR-based-Attendance-/releases/download/mobile-v${version}/EduTrack-Mobile-${version}.apk`;
}

app.get('/mobile-config.json', (req, res) => {
    res.json({
        base_url: getPublicAppBaseUrl(req),
        fallback_urls: [],
        mobile_app_version: MOBILE_APP_LATEST.version,
        desktop_scanner_version: DESKTOP_SCANNER_LATEST.version,
        notification_capabilities: {
            closed_app_fcm: true,
            daily_report_7pm: true,
            two_day_absence_flags: true
        }
    });
});

app.get('/api/mobile-app-version', (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'downloads', 'school-attendance-division.apk');
    let apkSize = null;
    let apkUpdatedAt = null;
    try {
        const stat = fs.statSync(apkPath);
        apkSize = stat.size;
        apkUpdatedAt = stat.mtime.toISOString();
    } catch (_) {
        /* APK may not be uploaded yet */
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
        latest_version: MOBILE_APP_LATEST.version,
        latest_version_code: MOBILE_APP_LATEST.version_code,
        apk_url: `${getPublicAppBaseUrl(req)}/download/mobile-app?v=${MOBILE_APP_LATEST.version_code}`,
        apk_available: apkSize !== null,
        apk_size: apkSize,
        apk_updated_at: apkUpdatedAt,
        notes: MOBILE_APP_LATEST.notes
    });
});

// Dedicated endpoint the desktop scanner polls to discover new versions.
// Returns the latest version, an installer URL, and a SHA hint when available.
app.get('/api/desktop-scanner/version', (req, res) => {
    const installerPath = path.join(__dirname, 'public', 'downloads', 'Edutrack-Scanner-Setup.exe');
    let size = null;
    let mtime = null;
    try {
        const stat = fs.statSync(installerPath);
        size = stat.size;
        mtime = stat.mtime.toISOString();
    } catch (_) { /* installer not yet built */ }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
        latest_version: DESKTOP_SCANNER_LATEST.version,
        notes: DESKTOP_SCANNER_LATEST.notes,
        installer_url: `${getPublicAppBaseUrl(req)}/download/desktop-installer`,
        installer_size: size,
        installer_mtime: mtime,
        installer_available: size !== null
    });
});

// Direct download for the desktop installer (used by the in-app auto-updater).
// Mirrors the legacy /download/scanner-app behaviour but with a stable name.
app.get('/download/desktop-installer', (req, res) => {
    const installerPath = path.join(__dirname, 'public', 'downloads', 'Edutrack-Scanner-Setup.exe');
    if (!fs.existsSync(installerPath)) {
        return res.status(404).json({ error: 'Installer not yet available.' });
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.download(installerPath, `Edutrack-Scanner-Setup-${DESKTOP_SCANNER_LATEST.version}.exe`);
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Session
app.use(session({
    store: new MySQLSessionStore(),
    secret: process.env.SESSION_SECRET || 'qr-attendance-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: isProduction,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Make user and key settings available to all views
app.use(async (req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.locals.todayDate = todayDate();
    res.locals.currentMonth = currentMonth();
    // JSON/mobile requests never render the shared header. Skipping its branding
    // and school-context queries removes two unrelated database reads from every
    // dashboard poll, Guardian sync, and notification request.
    if (req.path.startsWith('/api/')) {
        res.locals.settings = {};
        res.locals.headerSchool = null;
        res.locals.adviserIsShs = false;
        return next();
    }
    try {
        const [rows] = await db.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('system_name','division_name','system_logo','platform_android_logo','platform_ios_logo','platform_windows_logo','platform_mac_logo')"
        );
        const settings = {};
        rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
        if (settings.system_logo) {
            settings.system_logo = settingImageUrl('system-logo', settings.system_logo);
        }
        res.locals.settings = settings;
    } catch (e) {
        res.locals.settings = {};
    }
    // Header school context for adviser & principal (name + logo, shown big in the topbar).
    // Advisers are resolved from their live teacher/section assignment instead of the
    // session copy, because a reassignment can happen while the session is still active.
    res.locals.headerSchool = null;
    res.locals.adviserIsShs = false;
    try {
        const u = req.session.user;
        if (u && u.role === 'adviser' && u.teacher_id) {
            const [[teacherSchool]] = await db.query(
                `SELECT
                    COALESCE(sec.school_id, t.school_id) AS school_id,
                    t.category,
                    sc.name,
                    sc.logo,
                    gl.name AS grade_name
                 FROM teachers t
                 LEFT JOIN sections sec ON sec.id = t.section_id
                 LEFT JOIN schools sc ON sc.id = COALESCE(sec.school_id, t.school_id)
                 LEFT JOIN grade_levels gl ON gl.id = COALESCE(sec.grade_level_id, t.grade_level_id)
                 WHERE t.id = ?
                 LIMIT 1`,
                [u.teacher_id]
            );
            if (teacherSchool && teacherSchool.school_id) {
                res.locals.headerSchool = {
                    name: teacherSchool.name,
                    logo: teacherSchool.logo
                        ? `/api/schools/${teacherSchool.school_id}/logo-image?v=${crypto.createHash('md5').update(String(teacherSchool.logo)).digest('hex').slice(0, 12)}`
                        : null
                };
                // Keep legacy/session-scoped code from pointing at the old school.
                u.school_id = teacherSchool.school_id;
                u.school_logo = res.locals.headerSchool.logo;
            }
            const gradeNumber = parseInt(String(teacherSchool && teacherSchool.grade_name || '').match(/\d+/)?.[0] || '', 10);
            res.locals.adviserIsShs = (teacherSchool && teacherSchool.category === 'shs_teacher') || (Number.isFinite(gradeNumber) && gradeNumber >= 11 && gradeNumber <= 12);
        } else if (u && u.role === 'principal' && u.school_id) {
            const [[school]] = await db.query(
                "SELECT name, logo FROM schools WHERE id = ? AND status = 'active'",
                [u.school_id]
            );
            if (school) {
                res.locals.headerSchool = {
                    name: school.name,
                    logo: school.logo
                        ? `/api/schools/${u.school_id}/logo-image?v=${crypto.createHash('md5').update(String(school.logo)).digest('hex').slice(0, 12)}`
                        : null
                };
            }
        }
    } catch (e) {
        res.locals.headerSchool = null;
    }
    next();
});

// Routes
const authRoutes = require('./routes/auth');
const parentRoutes = require('./routes/parent');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const exportRoutes = require('./routes/export');
const transferRoutes = require('./routes/transfers');

app.use('/', parentRoutes);
app.use('/', authRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/export', exportRoutes);

function getDashboardUrl(role) {
    if (role === 'parent') return '/parent/app';
    if (role === 'principal') return '/admin/principal-dashboard';
    if (role === 'superintendent') return '/admin/sds-dashboard';
    if (role === 'asst_superintendent') return '/admin/asds-dashboard';
    if (role === 'adviser') return '/admin/adviser-dashboard';
    return '/admin/dashboard';
}

function getPublicAppBaseUrl(req) {
    const configured = process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    const normalizedConfigured = configured.replace(/\/+$/, '');
    if (normalizedConfigured && !/localhost|127\.0\.0\.1/i.test(normalizedConfigured)) {
        return normalizedConfigured;
    }
    const host = req.get('host') || '';
    if (host.includes('localhost') || host.startsWith('127.0.0.1')) {
        return '';
    }
    return `${req.protocol}://${host}`.replace(/\/+$/, '');
}

async function ensureRuntimeColumnDefinition({
    tableName,
    columnName,
    definition,
    expectedType,
    expectedNullable,
    expectedDefault
}) {
    if (!/^[a-z_]+$/i.test(tableName) || !/^[a-z_]+$/i.test(columnName)) {
        throw new Error('Unsafe runtime schema identifier.');
    }
    const [[column]] = await db.query(
        `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
         LIMIT 1`,
        [tableName, columnName]
    );
    if (!column) return;
    const actualType = String(column.COLUMN_TYPE || '').toLowerCase();
    const actualNullable = String(column.IS_NULLABLE || '').toUpperCase();
    const actualDefault = column.COLUMN_DEFAULT == null ? null : String(column.COLUMN_DEFAULT).toLowerCase();
    if (actualType === expectedType.toLowerCase()
        && actualNullable === expectedNullable
        && actualDefault === expectedDefault) return;
    await db.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${definition}`);
    console.log(`Updated ${tableName}.${columnName} definition.`);
}

async function ensureRuntimeSchema() {
    const [columns] = await db.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'students'
           AND COLUMN_NAME = 'active_from'`
    );
    if (columns.length === 0) {
        await db.query('ALTER TABLE students ADD COLUMN active_from DATE NULL AFTER qr_code');
        console.log('Added missing students.active_from column.');
    }

    const [teacherActiveFromColumns] = await db.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'teachers'
           AND COLUMN_NAME = 'active_from'`
    );
    if (teacherActiveFromColumns.length === 0) {
        await db.query('ALTER TABLE teachers ADD COLUMN active_from DATE NULL AFTER qr_code');
        console.log('Added missing teachers.active_from column.');
    }

    await ensureRuntimeColumnDefinition({
        tableName: 'students',
        columnName: 'status',
        definition: "ENUM('active','inactive','deleted') DEFAULT 'inactive'",
        expectedType: "enum('active','inactive','deleted')",
        expectedNullable: 'YES',
        expectedDefault: 'inactive'
    });
    await ensureRuntimeColumnDefinition({
        tableName: 'teachers',
        columnName: 'status',
        definition: "ENUM('active','inactive','deleted') DEFAULT 'inactive'",
        expectedType: "enum('active','inactive','deleted')",
        expectedNullable: 'YES',
        expectedDefault: 'inactive'
    });
    await ensureRuntimeColumnDefinition({
        tableName: 'attendance',
        columnName: 'status',
        definition: "ENUM('present','late','half_day','absent') DEFAULT 'present'",
        expectedType: "enum('present','late','half_day','absent')",
        expectedNullable: 'YES',
        expectedDefault: 'present'
    });

    // Imported students should not become attendance-eligible until their first valid attendance scan.
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

    // Reset imported teachers that were never manually activated and have no attendance.
    // active_from IS NULL means they were never explicitly activated by an admin — safe to reset.
    const [inactiveTeachersResult] = await db.query(`
        UPDATE teachers t
        SET t.status = 'inactive',
            t.active_from = NULL
        WHERE t.status = 'active'
          AND t.active_from IS NULL
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

    // Multi time-in/time-out support: latest time-in + monitoring status on the daily row.
    const [attendanceColumns] = await db.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'attendance'
           AND COLUMN_NAME IN ('last_time_in', 'monitoring_status')`
    );
    const attendanceColumnNames = attendanceColumns.map(col => col.COLUMN_NAME);
    if (!attendanceColumnNames.includes('last_time_in')) {
        await db.query('ALTER TABLE attendance ADD COLUMN last_time_in DATETIME NULL AFTER time_in');
        await db.query('UPDATE attendance SET last_time_in = time_in WHERE last_time_in IS NULL');
        console.log('Added missing attendance.last_time_in column.');
    }
    if (!attendanceColumnNames.includes('monitoring_status')) {
        await db.query("ALTER TABLE attendance ADD COLUMN monitoring_status VARCHAR(20) NULL AFTER status");
        console.log('Added missing attendance.monitoring_status column.');
    }

    // Full transaction audit trail — every time-in/time-out scan is stored here.
    await db.query(`
        CREATE TABLE IF NOT EXISTS attendance_events (
            id INT AUTO_INCREMENT PRIMARY KEY,
            attendance_id INT NOT NULL,
            person_type ENUM('student','teacher') NOT NULL,
            person_id INT NOT NULL,
            school_id INT NOT NULL,
            date DATE NOT NULL,
            event ENUM('time_in','time_out') NOT NULL,
            event_label VARCHAR(20) NOT NULL DEFAULT '',
            event_time DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_att_events_attendance (attendance_id),
            INDEX idx_att_events_person_date (person_type, person_id, date)
        ) ENGINE=InnoDB
    `);

    // Official attendance schedule defaults. Old shipped defaults are migrated
    // to the current policy, while deliberate custom values are preserved.
    await db.query(`
        INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
        ('am_time_in_end', '07:00:00'),
        ('am_late_time', '07:15:00'),
        ('lunch_break_start', '11:00:00'),
        ('pm_time_in_start', '13:00:00'),
        ('pm_late_time', '13:15:00'),
        ('pm_time_out_end', '16:00:00'),
        ('absence_cutoff_time', '16:00:00'),
        ('teacher_duty_end_time', '16:00:00')
    `);
    await db.query(`
        UPDATE settings
        SET setting_value = CASE setting_key
            WHEN 'am_time_in_end' THEN '07:00:00'
            WHEN 'am_late_time' THEN '07:15:00'
            WHEN 'lunch_break_start' THEN '11:00:00'
            WHEN 'pm_late_time' THEN '13:15:00'
            WHEN 'pm_time_out_end' THEN '16:00:00'
            WHEN 'absence_cutoff_time' THEN '16:00:00'
            WHEN 'teacher_duty_end_time' THEN '16:00:00'
            ELSE setting_value
        END
        WHERE (setting_key = 'am_time_in_end' AND (setting_value IS NULL OR setting_value IN ('', '07:30', '07:30:00')))
           OR (setting_key = 'am_late_time' AND (setting_value IS NULL OR setting_value = ''))
           OR (setting_key = 'lunch_break_start' AND (setting_value IS NULL OR setting_value IN ('', '11:30', '11:30:00')))
           OR (setting_key = 'pm_late_time' AND (setting_value IS NULL OR setting_value = ''))
           OR (setting_key = 'pm_time_out_end' AND (setting_value IS NULL OR setting_value IN ('', '17:00', '17:00:00')))
           OR (setting_key = 'absence_cutoff_time' AND (setting_value IS NULL OR setting_value IN ('', '17:00', '17:00:00')))
           OR (setting_key = 'teacher_duty_end_time' AND (setting_value IS NULL OR setting_value IN ('', '17:00', '17:00:00')))
    `);

    // Role support: expand users.role ENUM + add teacher_id link column.
    await ensureRuntimeColumnDefinition({
        tableName: 'users',
        columnName: 'role',
        definition: "ENUM('super_admin','principal','superintendent','asst_superintendent','adviser','parent') NOT NULL DEFAULT 'principal'",
        expectedType: "enum('super_admin','principal','superintendent','asst_superintendent','adviser','parent')",
        expectedNullable: 'NO',
        expectedDefault: 'principal'
    });
    const [teacherIdCol] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'teacher_id'`
    );
    if (teacherIdCol.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN teacher_id INT NULL AFTER school_id');
        console.log('Added missing users.teacher_id column for adviser role.');
    }

    // Adviser direct-login: add password column to teachers table for email-based auth.
    const [teacherPwdCol] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'teachers' AND COLUMN_NAME = 'password'`
    );
    if (teacherPwdCol.length === 0) {
        await db.query('ALTER TABLE teachers ADD COLUMN password VARCHAR(255) NULL AFTER email');
        console.log('Added teachers.password column for adviser login.');
    }

    const [teacherCatCol] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'teachers' AND COLUMN_NAME = 'category'`
    );
    if (teacherCatCol.length === 0) {
        await db.query("ALTER TABLE teachers ADD COLUMN category ENUM('teacher','shs_teacher') DEFAULT 'teacher' AFTER status");
        console.log('Added teachers.category column for SHS teacher distinction.');
    }

    // Adviser profile photo (base64 data URL, like users.profile_photo). MySQL
    // does NOT support `ADD COLUMN IF NOT EXISTS`, so the column must be created
    // here with a probe — otherwise the adviser profile load + photo upload 500.
    const [teacherPhotoCol] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'teachers' AND COLUMN_NAME = 'profile_photo'`
    );
    if (teacherPhotoCol.length === 0) {
        await db.query('ALTER TABLE teachers ADD COLUMN profile_photo MEDIUMTEXT NULL');
        console.log('Added teachers.profile_photo column for adviser profile photos.');
    }

    const [teacherLastLoginCol] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'teachers' AND COLUMN_NAME = 'last_login'`
    );
    if (teacherLastLoginCol.length === 0) {
        await db.query('ALTER TABLE teachers ADD COLUMN last_login TIMESTAMP NULL AFTER status');
        console.log('Added teachers.last_login column for active-user monitoring.');
    }

    await db.query(`
        CREATE TABLE IF NOT EXISTS parents (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guardian_name VARCHAR(255) NOT NULL,
            contact_number VARCHAR(100) NOT NULL,
            normalized_contact VARCHAR(30) NOT NULL UNIQUE,
            username VARCHAR(100) UNIQUE,
            password VARCHAR(255) NOT NULL,
            status ENUM('active','inactive') DEFAULT 'active',
            last_login TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_parents_contact (normalized_contact),
            INDEX idx_parents_username (username)
        ) ENGINE=InnoDB
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(255),
            message TEXT,
            type VARCHAR(50),
            school_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
        ) ENGINE=InnoDB
    `);

    async function ensureRuntimeColumn(tableName, columnName, definition) {
        const [cols] = await db.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [tableName, columnName]
        );
        if (cols.length === 0) {
            await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
            console.log(`Added missing ${tableName}.${columnName} column.`);
        }
    }

    async function ensureRuntimeIndex(tableName, indexName, columns) {
        const [indexes] = await db.query(
            `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
            [tableName, indexName]
        );
        if (indexes.length === 0) {
            await db.query(`ALTER TABLE ${tableName} ADD INDEX ${indexName} (${columns})`);
            console.log(`Added missing ${tableName}.${indexName} index.`);
        }
    }

    // Schools map: optional GPS coordinates for the Sipalay City dashboard map.
    await ensureRuntimeColumn('schools', 'latitude', 'DECIMAL(10,8) NULL AFTER logo');
    await ensureRuntimeColumn('schools', 'longitude', 'DECIMAL(11,8) NULL AFTER latitude');

    await db.query(`
        CREATE TABLE IF NOT EXISTS holidays (
            id INT AUTO_INCREMENT PRIMARY KEY,
            holiday_date DATE NOT NULL,
            name VARCHAR(255) NOT NULL,
            school_id INT DEFAULT NULL,
            is_national TINYINT(1) DEFAULT 1,
            notification_id INT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_holiday_date_school (holiday_date, school_id),
            INDEX idx_holiday_date (holiday_date),
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
        ) ENGINE=InnoDB
    `);

    await ensureRuntimeColumn('notifications', 'grade_level_id', 'INT NULL AFTER school_id');
    await ensureRuntimeColumn('notifications', 'section_id', 'INT NULL AFTER grade_level_id');
    await ensureRuntimeColumn('notifications', 'student_id', 'INT NULL AFTER section_id');
    await ensureRuntimeColumn('notifications', 'target_audience', "VARCHAR(50) DEFAULT 'school' AFTER student_id");
    await ensureRuntimeColumn('notifications', 'attachment_url', 'MEDIUMTEXT AFTER target_audience');
    await ensureRuntimeColumn('notifications', 'created_by', 'INT NULL AFTER attachment_url');
    await ensureRuntimeColumn('notifications', 'created_by_name', 'VARCHAR(255) NULL AFTER created_by');
    await ensureRuntimeColumn('notifications', 'created_by_role', 'VARCHAR(50) NULL AFTER created_by_name');
    await ensureRuntimeColumn('holidays', 'notification_id', 'INT NULL AFTER is_national');

    await db.query(`
        CREATE TABLE IF NOT EXISTS user_devices (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            push_token VARCHAR(255) NOT NULL,
            platform VARCHAR(20),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_user_device_token (push_token),
            INDEX idx_user_devices_user (user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS system_push_deliveries (
            id INT AUTO_INCREMENT PRIMARY KEY,
            delivery_key VARCHAR(191) NOT NULL,
            user_id INT NOT NULL,
            notification_type VARCHAR(60) NOT NULL,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_system_push_delivery (delivery_key),
            INDEX idx_system_push_user (user_id, sent_at),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS desktop_scanner_devices (
            id INT AUTO_INCREMENT PRIMARY KEY,
            scanner_id VARCHAR(100) NOT NULL,
            school_id INT NULL,
            device_name VARCHAR(150),
            platform VARCHAR(30),
            app_version VARCHAR(50),
            scanner_mode VARCHAR(30),
            status VARCHAR(30) DEFAULT 'online',
            online TINYINT(1) DEFAULT 1,
            queued_count INT DEFAULT 0,
            queued_today_count INT DEFAULT 0,
            sync_in_progress TINYINT(1) DEFAULT 0,
            last_successful_sync_at DATETIME NULL,
            directory_last_refreshed_at DATETIME NULL,
            last_seen_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_desktop_scanner_id (scanner_id),
            INDEX idx_desktop_scanner_school_seen (school_id, last_seen_at),
            INDEX idx_desktop_scanner_seen (last_seen_at),
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
        ) ENGINE=InnoDB
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS desktop_scanner_commands (
            id INT AUTO_INCREMENT PRIMARY KEY,
            scanner_id VARCHAR(100) NOT NULL,
            school_id INT NULL,
            command VARCHAR(50) NOT NULL,
            payload_json TEXT NULL,
            status VARCHAR(30) DEFAULT 'pending',
            requested_by INT NULL,
            requested_by_name VARCHAR(255),
            requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            delivered_at TIMESTAMP NULL,
            acknowledged_at TIMESTAMP NULL,
            expires_at DATETIME NOT NULL,
            error_message TEXT NULL,
            INDEX idx_desktop_scanner_commands_pending (scanner_id, status, expires_at),
            INDEX idx_desktop_scanner_commands_school (school_id, requested_at),
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
        ) ENGINE=InnoDB
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS desktop_scanner_previews (
            scanner_id VARCHAR(100) PRIMARY KEY,
            school_id INT NULL,
            image_data MEDIUMTEXT NOT NULL,
            mime_type VARCHAR(50) DEFAULT 'image/jpeg',
            width INT DEFAULT 0,
            height INT DEFAULT 0,
            captured_at DATETIME NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_desktop_scanner_previews_school (school_id, captured_at),
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
        ) ENGINE=InnoDB
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS parent_devices (
            id INT AUTO_INCREMENT PRIMARY KEY,
            parent_id INT NOT NULL,
            contact_number VARCHAR(100),
            normalized_contact VARCHAR(30),
            device_token VARCHAR(255) NOT NULL,
            push_token TEXT,
            platform VARCHAR(50) DEFAULT 'android',
            app_version VARCHAR(50),
            device_name VARCHAR(150),
            user_agent TEXT,
            last_seen_at TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_parent_device_token (device_token),
            INDEX idx_parent_devices_parent (parent_id),
            INDEX idx_parent_devices_contact (normalized_contact),
            FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);
    await ensureRuntimeColumn('parent_devices', 'device_name', 'VARCHAR(150) NULL AFTER app_version');

    await db.query(`
        CREATE TABLE IF NOT EXISTS parent_notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            parent_id INT NOT NULL,
            student_id INT,
            school_id INT,
            grade_level_id INT,
            section_id INT,
            type VARCHAR(60) NOT NULL,
            title VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            source_key VARCHAR(191) NOT NULL,
            source_notification_id INT,
            created_by VARCHAR(255),
            created_by_role VARCHAR(50),
            is_read TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            read_at TIMESTAMP NULL,
            UNIQUE KEY uk_parent_notification_source (parent_id, source_key),
            INDEX idx_parent_notifications_parent_read (parent_id, is_read, created_at),
            INDEX idx_parent_notifications_student (student_id),
            INDEX idx_parent_notifications_scope (school_id, grade_level_id, section_id),
            FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
        ) ENGINE=InnoDB
    `);

    await ensureRuntimeIndex('parent_notifications', 'idx_parent_notifications_parent_id', 'parent_id, id');

    // Section transfer / reassignment approval requests. The approver is always a
    // teacher (the receiving section's adviser for a student transfer, or the
    // reassigned teacher for a principal reassignment).
    await db.query(`
        CREATE TABLE IF NOT EXISTS transfer_requests (
            id INT AUTO_INCREMENT PRIMARY KEY,
            request_type ENUM('student_section','teacher_section') NOT NULL,
            school_id INT NOT NULL,
            subject_id INT NOT NULL,
            subject_name VARCHAR(255),
            subject_lrn VARCHAR(50),
            from_section_id INT NULL,
            from_section_name VARCHAR(150),
            to_section_id INT NULL,
            to_section_name VARCHAR(150),
            to_grade_level_id INT NULL,
            requester_role VARCHAR(30),
            requester_id INT NULL,
            requester_name VARCHAR(255),
            approver_teacher_id INT NULL,
            status ENUM('pending','accepted','declined','cancelled') DEFAULT 'pending',
            note VARCHAR(255),
            requester_seen TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            resolved_at TIMESTAMP NULL,
            INDEX idx_tr_approver (approver_teacher_id, status),
            INDEX idx_tr_requester (requester_role, requester_id, status),
            INDEX idx_tr_school (school_id, status)
        ) ENGINE=InnoDB
    `);

    // One-time fix: parent_notifications for absent/flagged types were previously
    // inserted with a hardcoded 16:00:00 / 16:01:00 time. Replace those stale
    // timestamps with the actual current time so the inbox sort order and the
    // "Today HH:MM" label shown in the Flutter app are both accurate.
    await db.query(`
        UPDATE parent_notifications
        SET created_at = NOW()
        WHERE type IN ('attendance_absent', 'attendance_flagged')
          AND (TIME(created_at) = '16:00:00' OR TIME(created_at) = '16:01:00')
    `);

    // -----------------------------------------------------------------
    // School Year Transition System — foundation tables.
    // Many school years are supported but exactly ONE is active at a time.
    // Per-year enrollment records give every student a history (Grade 6 Rizal
    // last year, Grade 7 Mabini this year) and let old class lists be archived
    // while attendance, SF2, and QR records are preserved.
    //
    // SAFETY: this runs on a SINGLE dedicated connection with a short lock-wait
    // timeout so a busy table can never make startup hang, and the whole block
    // is wrapped so any failure is logged and retried next boot instead of
    // taking the app down. It deliberately creates only NEW, empty tables —
    // it does NOT alter the hot `attendance`/`attendance_events` tables, and
    // student_enrollments has no FK back to the in-use `students` table (which
    // would require a blocking metadata lock). Those are deferred to a later
    // phase where they can be done with care.
    // -----------------------------------------------------------------
    try {
        const syConn = await db.getConnection();
        try {
            // Bound every lock wait to a few seconds — fail fast, never hang.
            await syConn.query('SET SESSION lock_wait_timeout = 15');
            await syConn.query('SET SESSION innodb_lock_wait_timeout = 15');

            await syConn.query(`
                CREATE TABLE IF NOT EXISTS school_years (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    label VARCHAR(20) NOT NULL UNIQUE,
                    start_date DATE NULL,
                    end_date DATE NULL,
                    status ENUM('upcoming','active','closed') DEFAULT 'upcoming',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_school_years_status (status)
                ) ENGINE=InnoDB
            `);

            await syConn.query(`
                CREATE TABLE IF NOT EXISTS student_enrollments (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    student_id INT NOT NULL,
                    school_year_id INT NOT NULL,
                    school_id INT NULL,
                    grade_level_id INT NULL,
                    section_id INT NULL,
                    status ENUM('enrolled','not_enrolled','transferred_out','graduated','archived') DEFAULT 'enrolled',
                    transfer_to_school VARCHAR(255) NULL,
                    transfer_date DATE NULL,
                    remarks VARCHAR(500) NULL,
                    enrolled_by INT NULL,
                    activated_at DATETIME NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_enrollment_student_year (student_id, school_year_id),
                    INDEX idx_enrollment_year_section_status (school_year_id, section_id, status),
                    INDEX idx_enrollment_student (student_id)
                ) ENGINE=InnoDB
            `);

            // Seed the first two school years once: 2025-2026 (closed shell for
            // history) and 2026-2027 (the active year existing students roll
            // into). Dates are defaults the admin can edit later.
            const [[syCount]] = await syConn.query('SELECT COUNT(*) AS c FROM school_years');
            if (syCount.c === 0) {
                await syConn.query(`
                    INSERT INTO school_years (label, start_date, end_date, status) VALUES
                    ('2025-2026', '2025-08-01', '2026-06-30', 'closed'),
                    ('2026-2027', '2026-08-01', '2027-06-30', 'active')
                `);
                console.log('Seeded initial school years (2025-2026 closed, 2026-2027 active).');
            }

            // Backfill: give every non-deleted student an enrollment in the
            // active year, carrying their current grade/section. Idempotent —
            // the unique key + INSERT IGNORE make repeat startups a no-op.
            const [[activeYear]] = await syConn.query("SELECT id FROM school_years WHERE status = 'active' ORDER BY id DESC LIMIT 1");
            if (activeYear) {
                const [backfill] = await syConn.query(`
                    INSERT IGNORE INTO student_enrollments
                        (student_id, school_year_id, school_id, grade_level_id, section_id, status, activated_at, created_at)
                    SELECT s.id, ?, s.school_id, s.grade_level_id, s.section_id, 'enrolled', s.active_from, NOW()
                    FROM students s
                    WHERE s.status <> 'deleted'
                `, [activeYear.id]);
                if (backfill.affectedRows) {
                    console.log(`Backfilled ${backfill.affectedRows} student enrollment(s) into the active school year.`);
                }
            }
        } finally {
            syConn.release();
        }
    } catch (err) {
        console.error('School Year foundation migration skipped (will retry next boot):', err.message);
    }
}

// Root redirect
app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect(getDashboardUrl(req.session.user.role));
    }
    res.redirect('/login');
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    return res.redirect(getDashboardUrl(req.session.user.role));
});

app.get('/app', (req, res) => {
    if (req.session.user) {
        return res.redirect(getDashboardUrl(req.session.user.role));
    }
    return res.redirect('/login');
});

app.get('/scanner', (req, res) => {
    return res.render('scanner', {
        title: 'QR Scanner',
        page: 'scanner',
        kioskMode: true,
        scannerKioskToken: getScannerKioskToken()
    });
});

app.get('/api/app-info', (req, res) => {
    return res.json({
        app: 'school-attendance-qr-based-systems',
        name: 'Edutrack',
        baseUrl: getPublicAppBaseUrl(req)
    });
});

app.get('/api/mobile-health', (req, res) => {
    return res.json({
        ok: true,
        authenticated: !!(req.session && req.session.user),
        firebase: firebasePushStatus(),
        serverTime: nowIso()
    });
});

function manilaDateString() {
    return todayDate();
}

async function getDownloadPageStats() {
    const today = manilaDateString();
    const fallback = {
        today,
        totalSchools: 0,
        totalStudents: 0,
        totalTeachers: 0,
        presentToday: 0,
        absentToday: 0
    };

    try {
        const [[schoolRows], [studentRows], [teacherRows], [presentRows]] = await Promise.all([
            db.query("SELECT COUNT(*) as count FROM schools WHERE status = 'active'"),
            db.query("SELECT COUNT(*) as count FROM students WHERE status = 'active'"),
            db.query("SELECT COUNT(*) as count FROM teachers WHERE status = 'active'"),
            db.query(`SELECT COUNT(DISTINCT a.person_id) as count
                FROM attendance a
                INNER JOIN students s ON a.person_id = s.id
                WHERE a.person_type = 'student'
                    AND s.status = 'active'
                    AND a.date = ?
                    AND a.time_in IS NOT NULL`, [today])
        ]);

        return {
            today,
            totalSchools: schoolRows[0]?.count || 0,
            totalStudents: studentRows[0]?.count || 0,
            totalTeachers: teacherRows[0]?.count || 0,
            presentToday: presentRows[0]?.count || 0,
            absentToday: Math.max(0, (studentRows[0]?.count || 0) - (presentRows[0]?.count || 0))
        };
    } catch (err) {
        console.error('Download page stats failed:', err);
        return fallback;
    }
}

function getScannerPackageParts() {
    const downloadsDir = path.join(__dirname, 'public', 'downloads');
    const parts = [];
    for (let i = 1; i <= 12; i++) {
        const filename = `Edutrack-Scanner-Windows.zip.part${i}`;
        const filePath = path.join(downloadsDir, filename);
        if (!fs.existsSync(filePath)) break;
        parts.push({ filename, filePath });
    }
    return parts;
}

app.get('/mobile-app', async (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'downloads', 'school-attendance-division.apk');
    const iosPath = path.join(__dirname, 'public', 'downloads', 'edutrack-ios.ipa');
    const scannerInstallerPath = path.join(__dirname, 'public', 'downloads', 'Edutrack-Scanner-Setup.exe');
    const scannerPackageParts = getScannerPackageParts();
    const appBaseUrl = getPublicAppBaseUrl(req);
    const stats = await getDownloadPageStats();
    res.render('mobile_app', {
        title: 'Download Edutrack Apps',
        apkAvailable: fs.existsSync(apkPath),
        iosAvailable: fs.existsSync(iosPath),
        desktopAvailable: true,
        scannerInstallerAvailable: fs.existsSync(scannerInstallerPath) || scannerPackageParts.length > 0,
        stats,
        appBaseUrl
    });
});

app.get('/download/mobile-app', (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'downloads', 'school-attendance-division.apk');
    if (!fs.existsSync(apkPath)) {
        const appBaseUrl = getPublicAppBaseUrl(req);
        return res.status(404).render('mobile_app', {
            title: 'Download Edutrack Apps',
            apkAvailable: false,
            desktopAvailable: true,
            stats: {
                today: manilaDateString(),
                totalSchools: 0,
                totalStudents: 0,
                totalTeachers: 0,
                presentToday: 0,
                absentToday: 0
            },
            appBaseUrl,
            error: 'The APK file has not been uploaded yet.'
        });
    }
    if (String(req.query.v || '') !== String(MOBILE_APP_LATEST.version_code)) {
        return res.redirect(302, `/download/mobile-app?v=${MOBILE_APP_LATEST.version_code}`);
    }

    // Keep the public EduTrack link stable, but let GitHub Releases carry the
    // large binary payload instead of charging it to Railway network egress.
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.redirect(302, mobileApkReleaseUrl());
});

app.get('/download/ios-app', (req, res) => {
    const iosPath = path.join(__dirname, 'public', 'downloads', 'edutrack-ios.ipa');
    if (!fs.existsSync(iosPath)) {
        const appBaseUrl = getPublicAppBaseUrl(req);
        return res.status(404).render('mobile_app', {
            title: 'Download Edutrack Apps',
            apkAvailable: fs.existsSync(path.join(__dirname, 'public', 'downloads', 'school-attendance-division.apk')),
            iosAvailable: false,
            desktopAvailable: true,
            stats: {
                today: manilaDateString(),
                totalSchools: 0,
                totalStudents: 0,
                totalTeachers: 0,
                presentToday: 0,
                absentToday: 0
            },
            appBaseUrl,
            error: 'The iOS app package has not been uploaded yet.'
        });
    }
    return res.download(iosPath, 'Edutrack-iOS.ipa');
});

function sendWindowsDesktopLauncher(req, res) {
    const appBaseUrl = getPublicAppBaseUrl(req);
    const launcher = `@echo off\r\n`
        + `set "APP_URL=${appBaseUrl}/app"\r\n`
        + `set "APP_NAME=Edutrack"\r\n`
        + `where msedge >nul 2>nul\r\n`
        + `if %ERRORLEVEL%==0 (\r\n`
        + `  start "" msedge --app="%APP_URL%"\r\n`
        + `  exit /b\r\n`
        + `)\r\n`
        + `where chrome >nul 2>nul\r\n`
        + `if %ERRORLEVEL%==0 (\r\n`
        + `  start "" chrome --app="%APP_URL%"\r\n`
        + `  exit /b\r\n`
        + `)\r\n`
        + `start "" "%APP_URL%"\r\n`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Edutrack-Desktop-App.cmd"');
    return res.send(launcher);
}

function sendWindowsScannerLauncher(req, res) {
    const appBaseUrl = getPublicAppBaseUrl(req);
    const launcher = `@echo off\r\n`
        + `set "APP_URL=${appBaseUrl}/scanner"\r\n`
        + `set "APP_DIR=%LOCALAPPDATA%\\Edutrack"\r\n`
        + `set "PROFILE_DIR=%APP_DIR%\\ScannerProfile"\r\n`
        + `if not exist "%APP_DIR%" mkdir "%APP_DIR%" >nul 2>nul\r\n`
        + `if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%" >nul 2>nul\r\n`
        + `where msedge >nul 2>nul\r\n`
        + `if %ERRORLEVEL%==0 (\r\n`
        + `  start "" msedge --user-data-dir="%PROFILE_DIR%" --kiosk "%APP_URL%" --edge-kiosk-type=fullscreen --no-first-run --no-default-browser-check --disable-sync --disable-extensions --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required\r\n`
        + `  exit /b\r\n`
        + `)\r\n`
        + `where chrome >nul 2>nul\r\n`
        + `if %ERRORLEVEL%==0 (\r\n`
        + `  start "" chrome --user-data-dir="%PROFILE_DIR%" --kiosk "%APP_URL%" --new-window --no-first-run --no-default-browser-check --disable-sync --disable-extensions --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required\r\n`
        + `  exit /b\r\n`
        + `)\r\n`
        + `start "" "%APP_URL%"\r\n`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Edutrack-Scanner-App.cmd"');
    return res.send(launcher);
}

function sendWindowsScannerInstaller(req, res) {
    const installerPath = path.join(__dirname, 'public', 'downloads', 'Edutrack-Scanner-Setup.exe');
    if (fs.existsSync(installerPath)) {
        return res.download(installerPath, 'Edutrack-Scanner-Setup.exe');
    }
    const packageParts = getScannerPackageParts();
    if (packageParts.length > 0) {
        const appBaseUrl = getPublicAppBaseUrl(req) || `${req.protocol}://${req.get('host') || ''}`.replace(/\/+$/, '');
        const partUrls = packageParts.map(part => `${appBaseUrl}/downloads/${part.filename}`);
        const psLines = [
            "$ErrorActionPreference = 'Stop'",
            "$ProgressPreference = 'SilentlyContinue'",
            "$installDir = Join-Path $env:LOCALAPPDATA 'Edutrack Scanner'",
            "$tmpDir = Join-Path $env:TEMP 'EdutrackScannerInstall'",
            "$zipPath = Join-Path $tmpDir 'Edutrack-Scanner-Windows.zip'",
            '$partUrls = @(',
            ...partUrls.map(url => `'${url}'`),
            ')',
            "Write-Host 'Downloading Edutrack Scanner desktop app...'",
            'New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null',
            'Remove-Item $zipPath -Force -ErrorAction SilentlyContinue',
            '$partFiles = @()',
            'for ($i = 0; $i -lt $partUrls.Count; $i++) {',
            "  $partFile = Join-Path $tmpDir ('scanner.part' + ($i + 1))",
            '  Invoke-WebRequest -Uri $partUrls[$i] -OutFile $partFile -UseBasicParsing',
            '  $partFiles += $partFile',
            '}',
            "Write-Host 'Preparing installer package...'",
            '$out = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)',
            'try {',
            '  foreach ($partFile in $partFiles) {',
            '    $in = [System.IO.File]::OpenRead($partFile)',
            '    try { $in.CopyTo($out) } finally { $in.Close() }',
            '  }',
            '} finally { $out.Close() }',
            "Write-Host 'Installing Edutrack Scanner...'",
            'if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }',
            'New-Item -ItemType Directory -Force -Path $installDir | Out-Null',
            'Expand-Archive -Path $zipPath -DestinationPath $installDir -Force',
            "$exe = Join-Path $installDir 'Edutrack Scanner.exe'",
            "if (!(Test-Path $exe)) { throw 'Edutrack Scanner executable was not installed correctly.' }",
            '$ws = New-Object -ComObject WScript.Shell',
            "$desktop = [Environment]::GetFolderPath('Desktop')",
            "$startMenu = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'",
            "$links = @((Join-Path $desktop 'Edutrack Scanner.lnk'), (Join-Path $startMenu 'Edutrack Scanner.lnk'))",
            'foreach ($linkPath in $links) {',
            '  $shortcut = $ws.CreateShortcut($linkPath)',
            '  $shortcut.TargetPath = $exe',
            '  $shortcut.WorkingDirectory = $installDir',
            '  $shortcut.IconLocation = $exe',
            "  $shortcut.Description = 'Edutrack Scanner'",
            '  $shortcut.Save()',
            '}',
            "Write-Host 'Launching Edutrack Scanner dashboard...'",
            'Start-Process -FilePath $exe',
            "Write-Host 'Edutrack Scanner installed successfully.'"
        ];

        function escapeBatchEcho(line) {
            return String(line)
                .replace(/\^/g, '^^')
                .replace(/&/g, '^&')
                .replace(/\|/g, '^|')
                .replace(/</g, '^<')
                .replace(/>/g, '^>');
        }

        const batchLines = [
            '@echo off',
            'setlocal',
            'set "TMP_DIR=%TEMP%\\EdutrackScannerInstall"',
            'set "PS1=%TMP_DIR%\\install-edutrack-scanner.ps1"',
            'if not exist "%TMP_DIR%" mkdir "%TMP_DIR%"',
            'echo Installing Edutrack Scanner desktop app...',
            `> "%PS1%" echo ${escapeBatchEcho(psLines[0])}`,
            ...psLines.slice(1).map(line => line ? `>> "%PS1%" echo ${escapeBatchEcho(line)}` : '>> "%PS1%" echo.'),
            'powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"',
            'if errorlevel 1 (',
            '  echo.',
            '  echo Edutrack Scanner installation failed. Please check your internet connection and try again.',
            '  pause',
            '  exit /b 1',
            ')',
            'echo.',
            'echo Edutrack Scanner is installed successfully.',
            'echo You can enable or disable Windows auto-start inside the app settings.',
            'echo You can close this window.',
            'timeout /t 4 /nobreak >nul',
            'exit /b 0'
        ];

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="Edutrack-Scanner-Windows-Installer.cmd"');
        return res.send(batchLines.join('\r\n') + '\r\n');
    }
    return sendWindowsScannerLauncher(req, res);
}

function sendWindowsScannerAutostart(req, res) {
    const appBaseUrl = getPublicAppBaseUrl(req);
    const launcher = [
        '@echo off',
        'setlocal',
        `set "APP_URL=${appBaseUrl}/scanner"`,
        'set "APP_DIR=%LOCALAPPDATA%\\Edutrack"',
        'set "APP_FILE=Edutrack-Scanner-App.cmd"',
        'set "APP_LAUNCHER=%APP_DIR%\\%APP_FILE%"',
        'set "STARTUP_DIR=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"',
        'set "STARTUP_LINK=%STARTUP_DIR%\\Edutrack Scanner App.lnk"',
        'set "STARTUP_CMD=%STARTUP_DIR%\\Edutrack Scanner App.cmd"',
        'set "RUN_KEY=HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"',
        'set "RUN_NAME=Edutrack Scanner App"',
        'set "TASK_NAME=Edutrack Scanner App"',
        'set "DESKTOP_DIR=%USERPROFILE%\\Desktop"',
        'if not exist "%DESKTOP_DIR%" if defined OneDrive set "DESKTOP_DIR=%OneDrive%\\Desktop"',
        'if not exist "%DESKTOP_DIR%" set "DESKTOP_DIR=%USERPROFILE%"',
        'set "DESKTOP_LINK=%DESKTOP_DIR%\\Edutrack Scanner App.lnk"',
        'if not exist "%APP_DIR%" mkdir "%APP_DIR%"',
        'if not exist "%STARTUP_DIR%" mkdir "%STARTUP_DIR%"',
        'del "%DESKTOP_DIR%\\Edutrack Scanner App.cmd" >nul 2>nul',
        'del "%STARTUP_CMD%" >nul 2>nul',
        'del "%STARTUP_LINK%" >nul 2>nul',
        'reg delete "%RUN_KEY%" /v "%RUN_NAME%" /f >nul 2>nul',
        'schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>nul',
        'call :writeLauncher "%APP_LAUNCHER%"',
        'copy /Y "%APP_LAUNCHER%" "%STARTUP_CMD%" >nul 2>nul',
        'call :createShortcut "%DESKTOP_LINK%" "%APP_LAUNCHER%"',
        'call :createShortcut "%STARTUP_LINK%" "%APP_LAUNCHER%"',
        'reg add "%RUN_KEY%" /v "%RUN_NAME%" /t REG_SZ /d "\\"%APP_LAUNCHER%\\"" /f >nul 2>nul',
        'schtasks /Create /SC ONLOGON /TN "%TASK_NAME%" /TR "\\"%APP_LAUNCHER%\\"" /F >nul 2>nul',
        'echo.',
        'echo Edutrack Scanner Autostart has been installed.',
        'echo Desktop shortcut: %DESKTOP_LINK%',
        'echo Startup shortcut: %STARTUP_LINK%',
        'echo Startup command: %STARTUP_CMD%',
        'echo Windows Run entry: %RUN_NAME%',
        'echo Windows logon task: %TASK_NAME%',
        'echo.',
        'echo The scanner will open automatically in fullscreen when this Windows account signs in or restarts.',
        'echo If Windows asks for permission, choose Yes or Run.',
        'echo.',
        'echo Opening scanner now...',
        'start "" "%APP_LAUNCHER%"',
        'echo.',
        'echo Setup complete. You can close this window.',
        'pause',
        'exit /b',
        '',
        ':writeLauncher',
        '> "%~1" echo @echo off',
        '>> "%~1" echo set "APP_URL=%APP_URL%"',
        '>> "%~1" echo set "APP_DIR=%%LOCALAPPDATA%%\\Edutrack"',
        '>> "%~1" echo set "PROFILE_DIR=%%APP_DIR%%\\ScannerProfile"',
        '>> "%~1" echo set "LOCK_DIR=%%TEMP%%\\EdutrackScannerLaunch.lock"',
        '>> "%~1" echo if not exist "%%APP_DIR%%" mkdir "%%APP_DIR%%" ^>nul 2^>nul',
        '>> "%~1" echo if not exist "%%PROFILE_DIR%%" mkdir "%%PROFILE_DIR%%" ^>nul 2^>nul',
        '>> "%~1" echo mkdir "%%LOCK_DIR%%" 2^>nul ^|^| exit /b',
        '>> "%~1" echo set "EDGE_X86=%%ProgramFiles(x86)%%\\Microsoft\\Edge\\Application\\msedge.exe"',
        '>> "%~1" echo set "EDGE_X64=%%ProgramFiles%%\\Microsoft\\Edge\\Application\\msedge.exe"',
        '>> "%~1" echo set "CHROME_X64=%%ProgramFiles%%\\Google\\Chrome\\Application\\chrome.exe"',
        '>> "%~1" echo set "CHROME_X86=%%ProgramFiles(x86)%%\\Google\\Chrome\\Application\\chrome.exe"',
        '>> "%~1" echo if exist "%%EDGE_X86%%" ^(start "" "%%EDGE_X86%%" --user-data-dir="%%PROFILE_DIR%%" --kiosk "%%APP_URL%%" --edge-kiosk-type=fullscreen --no-first-run --no-default-browser-check --disable-sync --disable-extensions --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required ^& timeout /t 8 /nobreak ^>nul ^& rd "%%LOCK_DIR%%" ^>nul 2^>nul ^& exit /b^)',
        '>> "%~1" echo if exist "%%EDGE_X64%%" ^(start "" "%%EDGE_X64%%" --user-data-dir="%%PROFILE_DIR%%" --kiosk "%%APP_URL%%" --edge-kiosk-type=fullscreen --no-first-run --no-default-browser-check --disable-sync --disable-extensions --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required ^& timeout /t 8 /nobreak ^>nul ^& rd "%%LOCK_DIR%%" ^>nul 2^>nul ^& exit /b^)',
        '>> "%~1" echo if exist "%%CHROME_X64%%" ^(start "" "%%CHROME_X64%%" --user-data-dir="%%PROFILE_DIR%%" --kiosk "%%APP_URL%%" --new-window --no-first-run --no-default-browser-check --disable-sync --disable-extensions --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required ^& timeout /t 8 /nobreak ^>nul ^& rd "%%LOCK_DIR%%" ^>nul 2^>nul ^& exit /b^)',
        '>> "%~1" echo if exist "%%CHROME_X86%%" ^(start "" "%%CHROME_X86%%" --user-data-dir="%%PROFILE_DIR%%" --kiosk "%%APP_URL%%" --new-window --no-first-run --no-default-browser-check --disable-sync --disable-extensions --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required ^& timeout /t 8 /nobreak ^>nul ^& rd "%%LOCK_DIR%%" ^>nul 2^>nul ^& exit /b^)',
        '>> "%~1" echo start "" "%%APP_URL%%"',
        '>> "%~1" echo timeout /t 8 /nobreak ^>nul',
        '>> "%~1" echo rd "%%LOCK_DIR%%" ^>nul 2^>nul',
        'exit /b',
        '',
        ':createShortcut',
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut(\'%~1\'); $s.TargetPath=\'%~2\'; $s.WorkingDirectory=\'%APP_DIR%\'; $s.Save()" >nul 2>nul',
        'if not exist "%~1" copy /Y "%~2" "%~dp1Edutrack Scanner App.cmd" >nul 2>nul',
        'exit /b'
    ].join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Edutrack-Scanner-Autostart-Installer.cmd"');
    return res.send(launcher);
}

app.get('/download/desktop-app', sendWindowsDesktopLauncher);

app.get('/download/windows-app', sendWindowsDesktopLauncher);

app.get('/download/scanner-windows-app', sendWindowsScannerInstaller);

app.get('/download/scanner-app', sendWindowsScannerInstaller);

app.get('/download/scanner-autostart-app', sendWindowsScannerAutostart);

app.get('/download/scanner-autostart', sendWindowsScannerAutostart);

app.get('/download/mac-app', (req, res) => {
    const appBaseUrl = getPublicAppBaseUrl(req);
    const launcher = `#!/bin/bash\n`
        + `APP_URL="${appBaseUrl}/app"\n`
        + `if [ -d "/Applications/Google Chrome.app" ]; then\n`
        + `  open -na "Google Chrome" --args --app="$APP_URL"\n`
        + `elif [ -d "/Applications/Microsoft Edge.app" ]; then\n`
        + `  open -na "Microsoft Edge" --args --app="$APP_URL"\n`
        + `else\n`
        + `  open "$APP_URL"\n`
        + `fi\n`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Edutrack-Mac-App.command"');
    return res.send(launcher);
});

app.get('/download/scanner-mac-app', (req, res) => {
    const appBaseUrl = getPublicAppBaseUrl(req);
    const launcher = `#!/bin/bash\n`
        + `APP_URL="${appBaseUrl}/scanner"\n`
        + `if [ -d "/Applications/Google Chrome.app" ]; then\n`
        + `  open -na "Google Chrome" --args --kiosk "$APP_URL"\n`
        + `elif [ -d "/Applications/Microsoft Edge.app" ]; then\n`
        + `  open -na "Microsoft Edge" --args --kiosk "$APP_URL" --edge-kiosk-type=fullscreen\n`
        + `else\n`
        + `  open "$APP_URL"\n`
        + `fi\n`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Edutrack-Scanner-Mac-App.command"');
    return res.send(launcher);
});

// 404
app.use((req, res) => {
    res.status(404).render('error', {
        title: 'Page Not Found',
        message: 'The page you are looking for does not exist.',
        user: req.session.user || null
    });
});

// Error handler
app.use((err, req, res, _next) => {
    console.error('Server error:', err);
    res.status(500).render('error', {
        title: 'Server Error',
        message: 'An internal server error occurred.',
        user: req.session.user || null
    });
});

ensureRuntimeSchema()
    .catch((err) => {
        console.error('Runtime schema check failed:', err);
    })
    .finally(() => {
        app.listen(PORT, () => {
            console.log(`Edutrack running on port ${PORT}`);
            firebasePushStatus();
            startSystemPushScheduler();
        });
    });
