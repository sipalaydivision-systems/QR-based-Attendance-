require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const db = require('./config/database');
const MySQLSessionStore = require('./config/mysqlSessionStore');

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
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('system_name','division_name','system_logo')"
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

app.get('/api/app-info', (req, res) => {
    return res.json({
        app: 'edutrack',
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

app.get('/mobile-app', (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'downloads', 'school-attendance-division.apk');
    const appBaseUrl = getPublicAppBaseUrl(req);
    res.render('mobile_app', {
        title: 'Download Mobile App',
        apkAvailable: fs.existsSync(apkPath),
        appBaseUrl
    });
});

app.get('/download/mobile-app', (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'downloads', 'school-attendance-division.apk');
    if (!fs.existsSync(apkPath)) {
        const appBaseUrl = getPublicAppBaseUrl(req);
        return res.status(404).render('mobile_app', {
            title: 'Download Mobile App',
            apkAvailable: false,
            appBaseUrl,
            error: 'The APK file has not been uploaded yet.'
        });
    }
    return res.download(apkPath, 'Edutrack-Mobile.apk');
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

app.listen(PORT, () => {
    console.log(`Edutrack running on port ${PORT}`);
});
