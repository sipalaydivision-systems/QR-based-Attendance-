require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const db = require('./config/database');
const MySQLSessionStore = require('./config/mysqlSessionStore');
const { getScannerKioskToken } = require('./utils/scannerKiosk');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
    app.set('trust proxy', 1);
}

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/mobile-config.json', (req, res) => {
    res.json({
        base_url: getPublicAppBaseUrl(req),
        fallback_urls: []
    });
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
    try {
        const [rows] = await db.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('system_name','division_name','system_logo','platform_android_logo','platform_ios_logo','platform_windows_logo','platform_mac_logo')"
        );
        const settings = {};
        rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
        res.locals.settings = settings;
    } catch (e) {
        res.locals.settings = {};
    }
    next();
});

// Routes
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const exportRoutes = require('./routes/export');

app.use('/', authRoutes);
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/export', exportRoutes);

function getDashboardUrl(role) {
    if (role === 'principal') return '/admin/principal-dashboard';
    if (role === 'superintendent') return '/admin/sds-dashboard';
    if (role === 'asst_superintendent') return '/admin/asds-dashboard';
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

    await db.query("ALTER TABLE students MODIFY COLUMN status ENUM('active','inactive','deleted') DEFAULT 'inactive'");

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
        serverTime: new Date().toISOString()
    });
});

function manilaDateString() {
    return new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString().slice(0, 10);
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

app.get('/mobile-app', async (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'downloads', 'school-attendance-division.apk');
    const iosPath = path.join(__dirname, 'public', 'downloads', 'edutrack-ios.ipa');
    const appBaseUrl = getPublicAppBaseUrl(req);
    const stats = await getDownloadPageStats();
    res.render('mobile_app', {
        title: 'Download Edutrack Apps',
        apkAvailable: fs.existsSync(apkPath),
        iosAvailable: fs.existsSync(iosPath),
        desktopAvailable: true,
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
    return res.download(apkPath, 'Edutrack-Mobile.apk');
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

app.get('/download/scanner-windows-app', sendWindowsScannerLauncher);

app.get('/download/scanner-app', sendWindowsScannerLauncher);

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
        });
    });
