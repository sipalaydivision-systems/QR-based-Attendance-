// Authentication middleware
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

function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    if (wantsJson(req)) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
}

// Role-based access middleware
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            if (wantsJson(req)) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            return res.redirect('/login');
        }
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
    // Principals are hard-scoped to their own school and may NOT override via params.
    if (user.role === 'principal') {
        // Assigned school wins. If a principal has no school assigned, return a
        // sentinel that matches no rows so they see nothing instead of every school.
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
