// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
}

// Role-based access middleware
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            if (req.xhr || req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            return res.redirect('/login');
        }
        if (!roles.includes(req.session.user.role)) {
            if (req.xhr || req.path.startsWith('/api/')) {
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
    // Principals can only see their own school
    if (user.role === 'principal' && user.school_id) {
        return user.school_id;
    }
    // Other roles can filter by query param
    const schoolParam = req.query.school || req.body.school;
    return schoolParam ? parseInt(schoolParam, 10) : null;
}

module.exports = { requireAuth, requireRole, applySchoolFilter };
