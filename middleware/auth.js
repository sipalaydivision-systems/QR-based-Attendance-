// Authentication middleware
const db = require('../config/database');

function wantsJson(req) {
    const originalUrl = req.originalUrl || '';
    const baseUrl = req.baseUrl || '';
    const accept = req.get ? (req.get('accept') || '') : '';
    return Boolean(
        req.xhr ||
        originalUrl.startsWith('/api/') ||
        baseUrl === '/api' ||
        baseUrl.startsWith('/api/') ||
        accept.includes('application/json')
    );
}

function loginPathForRole(role) {
    if (role === 'parent') return '/parent-login';
    if (role === 'adviser') return '/adviser-login';
    return '/login';
}

function sendNotAuthenticated(req, res, message = 'Not authenticated') {
    if (wantsJson(req)) {
        return res.status(401).json({ error: message, code: 'SESSION_EXPIRED' });
    }
    return res.redirect(loginPathForRole(req.session && req.session.user && req.session.user.role));
}

function sendAccountDisabled(req, res) {
    const role = req.session && req.session.user && req.session.user.role;
    const message = 'This account was removed or disabled by the administrator. Please contact the school administrator.';
    req.session.destroy(() => {
        if (wantsJson(req)) {
            return res.status(401).json({ error: message, code: 'ACCOUNT_DISABLED' });
        }
        return res.redirect(loginPathForRole(role));
    });
}

async function validateSessionAccount(req) {
    const user = req.session && req.session.user;
    if (!user) return false;
    if (user.role === 'adviser') {
        const teacherId = user.teacher_id || user.id;
        if (!teacherId) return false;
        const [[teacher]] = await db.query(
            'SELECT id, status, school_id FROM teachers WHERE id = ? LIMIT 1',
            [teacherId]
        );
        if (!teacher || teacher.status === 'deleted') return false;
        req.session.user.teacher_id = teacher.id;
        req.session.user.school_id = teacher.school_id || null;
        return true;
    }
    if (user.role === 'parent') {
        const parentId = user.parent_id || user.id;
        if (!parentId) return false;
        const [[parent]] = await db.query(
            "SELECT id, status FROM parents WHERE id = ? LIMIT 1",
            [parentId]
        );
        return Boolean(parent && parent.status === 'active');
    }
    const [[row]] = await db.query(
        'SELECT id, username, fullname, email, role, school_id, teacher_id, status FROM users WHERE id = ? LIMIT 1',
        [user.id]
    );
    if (!row || row.status !== 'active') return false;
    req.session.user.username = row.username;
    req.session.user.fullname = row.fullname;
    req.session.user.email = row.email;
    req.session.user.role = row.role;
    req.session.user.school_id = row.school_id;
    req.session.user.teacher_id = row.teacher_id || null;
    return true;
}

async function ensureSessionAccount(req, res) {
    try {
        const ok = await validateSessionAccount(req);
        if (!ok) {
            sendAccountDisabled(req, res);
            return false;
        }
        return true;
    } catch (err) {
        console.error('Session account validation error:', err);
        if (wantsJson(req)) return res.status(500).json({ error: 'Unable to verify session.' });
        return res.status(500).render('error', {
            title: 'Session Error',
            message: 'Unable to verify your session. Please try again.',
            user: req.session && req.session.user
        });
    }
}

async function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        if (!(await ensureSessionAccount(req, res))) return;
        return next();
    }
    if (wantsJson(req)) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
}

// Role-based access middleware
function requireRole(...roles) {
    return async (req, res, next) => {
        if (!req.session || !req.session.user) {
            return sendNotAuthenticated(req, res);
        }
        if (!(await ensureSessionAccount(req, res))) return;
        if (!roles.includes(req.session.user.role)) {
            if (wantsJson(req)) {
                return res.status(403).json({ error: 'Access denied' });
            }
            return res.status(403).render('error', {
                title: 'Access Denied',
                message: 'You do not have permission to access this page.',
                user: req.session.user
            });
        }
        return next();
    };
}

// Apply school filter based on role
function applySchoolFilter(req) {
    const user = req.session.user;
    // Principals and advisers are hard-scoped to their assigned school and may
    // NOT override via params. The app middleware refreshes adviser school_id
    // from the live teacher/section assignment on each request.
    if (user.role === 'principal' || user.role === 'adviser') {
        // Assigned school wins. If none is assigned, return a sentinel that
        // matches no rows so they see nothing instead of every school.
        return user.school_id ? user.school_id : -1;
    }
    if (user.role === 'parent') {
        return -1;
    }
    // Other roles can filter by query param
    const schoolParam = req.query.school || req.body.school;
    return schoolParam ? parseInt(schoolParam, 10) : null;
}

module.exports = { requireAuth, requireRole, applySchoolFilter };
