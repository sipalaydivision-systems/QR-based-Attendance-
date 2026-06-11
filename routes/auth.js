const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const db = require('../config/database');
const { nowDateTime } = require('../utils/appTime');

// GET /login
router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { title: 'Login', error: null });
});

// POST /login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.render('login', { title: 'Login', error: 'Please enter username and password.' });
    }
    try {
        const [rows] = await db.query(
            'SELECT * FROM users WHERE username = ? AND status = ?',
            [username, 'active']
        );
        if (rows.length === 0) {
            return res.render('login', { title: 'Login', error: 'Invalid username or password.' });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.render('login', { title: 'Login', error: 'Invalid username or password.' });
        }
        // Store user in session (exclude password)
        req.session.user = {
            id: user.id,
            username: user.username,
            fullname: user.fullname,
            email: user.email,
            role: user.role,
            school_id: user.school_id,
            teacher_id: user.teacher_id || null
        };
        // Update last login
        await db.query('UPDATE users SET last_login = ? WHERE id = ?', [nowDateTime(), user.id]);
        // Log the action
        await db.query(
            'INSERT INTO user_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
            [user.id, 'login', req.ip]
        );
        // Redirect based on role
        const role = user.role;
        if (role === 'principal') return res.redirect('/admin/principal-dashboard');
        if (role === 'superintendent') return res.redirect('/admin/sds-dashboard');
        if (role === 'asst_superintendent') return res.redirect('/admin/asds-dashboard');
        if (role === 'adviser') return res.redirect('/admin/adviser-dashboard');
        return res.redirect('/admin/dashboard');
    } catch (err) {
        console.error('Login error:', err);
        return res.render('login', { title: 'Login', error: 'A server error occurred. Please try again.' });
    }
});

// POST /logout
router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// GET /change-password
router.get('/change-password', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('change_password', { title: 'Change Password', error: null, success: null, user: req.session.user });
});

// POST /change-password
router.post('/change-password', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password || !confirm_password) {
        return res.render('change_password', { title: 'Change Password', error: 'All fields are required.', success: null, user: req.session.user });
    }
    if (new_password !== confirm_password) {
        return res.render('change_password', { title: 'Change Password', error: 'New passwords do not match.', success: null, user: req.session.user });
    }
    if (new_password.length < 6) {
        return res.render('change_password', { title: 'Change Password', error: 'Password must be at least 6 characters.', success: null, user: req.session.user });
    }
    try {
        const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [req.session.user.id]);
        if (rows.length === 0) {
            return res.render('change_password', { title: 'Change Password', error: 'User not found.', success: null, user: req.session.user });
        }
        const match = await bcrypt.compare(current_password, rows[0].password);
        if (!match) {
            return res.render('change_password', { title: 'Change Password', error: 'Current password is incorrect.', success: null, user: req.session.user });
        }
        const hashed = await bcrypt.hash(new_password, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.session.user.id]);
        return res.render('change_password', { title: 'Change Password', error: null, success: 'Password changed successfully.', user: req.session.user });
    } catch (err) {
        console.error('Change password error:', err);
        return res.render('change_password', { title: 'Change Password', error: 'A server error occurred.', success: null, user: req.session.user });
    }
});

// ---- Adviser email lookup (used by login page JS to decide whether to show password field) ----
router.get('/adviser-check-email', async (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.json({ exists: false, hasPassword: false });
    try {
        const [rows] = await db.query(
            "SELECT id, password, status FROM teachers WHERE email = ? AND status != 'deleted'",
            [email]
        );
        if (rows.length === 0) return res.json({ exists: false, hasPassword: false });
        const teacher = rows[0];
        if (teacher.status === 'inactive') return res.json({ exists: true, inactive: true, hasPassword: !!teacher.password });
        return res.json({ exists: true, inactive: false, hasPassword: !!teacher.password });
    } catch (err) {
        return res.json({ exists: false, hasPassword: false });
    }
});

// ---- Adviser Login (email-based, separate from admin login) ----
router.get('/adviser-login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('adviser_login', { title: 'Adviser Login', error: null, email: '' });
});

router.post('/adviser-login', async (req, res) => {
    const { email, password } = req.body;
    if (!email) {
        return res.render('adviser_login', { title: 'Adviser Login', error: 'Please enter your email address.', email: '' });
    }
    try {
        const [rows] = await db.query(
            `SELECT t.*, sc.name as school_name, gl.name as grade_name, sec.name as section_name
             FROM teachers t
             LEFT JOIN schools sc ON t.school_id = sc.id
             LEFT JOIN grade_levels gl ON t.grade_level_id = gl.id
             LEFT JOIN sections sec ON t.section_id = sec.id
             WHERE t.email = ? AND t.status != 'deleted'`,
            [email.trim().toLowerCase()]
        );
        if (rows.length === 0) {
            return res.render('adviser_login', { title: 'Adviser Login', error: 'Email not found in teacher records. Please contact your administrator.', email });
        }
        const teacher = rows[0];

        // First-time login: no password set yet
        if (!teacher.password) {
            req.session.adviser_setup_id = teacher.id;
            req.session.adviser_setup_email = email.trim().toLowerCase();
            return res.redirect('/adviser-setup-password');
        }

        // Password not submitted (shouldn't happen with new form, but guard anyway)
        if (!password) {
            return res.render('adviser_login', { title: 'Adviser Login', error: 'Please enter your password.', email });
        }

        const match = await bcrypt.compare(password, teacher.password);
        if (!match) {
            return res.render('adviser_login', { title: 'Adviser Login', error: 'Incorrect password.', email });
        }

        req.session.user = {
            id: teacher.id,
            username: teacher.email,
            fullname: (teacher.firstname + ' ' + teacher.lastname).trim(),
            email: teacher.email,
            role: 'adviser',
            school_id: teacher.school_id,
            teacher_id: teacher.id
        };
        return res.redirect('/admin/adviser-dashboard');
    } catch (err) {
        console.error('Adviser login error:', err);
        return res.render('adviser_login', { title: 'Adviser Login', error: 'A server error occurred. Please try again.', email: '' });
    }
});

router.get('/adviser-setup-password', (req, res) => {
    if (!req.session.adviser_setup_id) return res.redirect('/adviser-login');
    res.render('adviser_setup_password', { title: 'Set Your Password', error: null, email: req.session.adviser_setup_email || '' });
});

router.post('/adviser-setup-password', async (req, res) => {
    const teacherId = req.session.adviser_setup_id;
    const email = req.session.adviser_setup_email;
    if (!teacherId) return res.redirect('/adviser-login');

    const { password, confirm_password } = req.body;
    if (!password || !confirm_password) {
        return res.render('adviser_setup_password', { title: 'Set Your Password', error: 'Both fields are required.', email });
    }
    if (password.length < 6) {
        return res.render('adviser_setup_password', { title: 'Set Your Password', error: 'Password must be at least 6 characters.', email });
    }
    if (password !== confirm_password) {
        return res.render('adviser_setup_password', { title: 'Set Your Password', error: 'Passwords do not match.', email });
    }
    try {
        const [check] = await db.query("SELECT id, password FROM teachers WHERE id = ? AND status != 'deleted'", [teacherId]);
        if (check.length === 0) {
            return res.render('adviser_setup_password', { title: 'Set Your Password', error: 'Teacher record not found.', email });
        }
        if (check[0].password) {
            delete req.session.adviser_setup_id;
            delete req.session.adviser_setup_email;
            return res.redirect('/adviser-login');
        }
        const hashed = await bcrypt.hash(password, 10);
        await db.query('UPDATE teachers SET password = ? WHERE id = ?', [hashed, teacherId]);

        delete req.session.adviser_setup_id;
        delete req.session.adviser_setup_email;

        req.session.user = {
            id: teacherId,
            username: email,
            fullname: (check.length > 0 ? '' : ''),
            email: email,
            role: 'adviser',
            school_id: null,
            teacher_id: teacherId
        };

        const [teacher] = await db.query('SELECT firstname, lastname, school_id FROM teachers WHERE id = ?', [teacherId]);
        if (teacher.length > 0) {
            req.session.user.fullname = (teacher[0].firstname + ' ' + teacher[0].lastname).trim();
            req.session.user.school_id = teacher[0].school_id;
        }

        return res.redirect('/admin/adviser-dashboard');
    } catch (err) {
        console.error('Adviser setup password error:', err);
        return res.render('adviser_setup_password', { title: 'Set Your Password', error: 'A server error occurred.', email });
    }
});

// Mobile app login (JSON)
router.post('/app-login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required.' });
    }
    try {
        const [rows] = await db.query(
            'SELECT * FROM users WHERE username = ? AND status = ?',
            [username, 'active']
        );
        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
        req.session.user = {
            id: user.id,
            username: user.username,
            fullname: user.fullname,
            email: user.email,
            role: user.role,
            school_id: user.school_id
        };
        await db.query('UPDATE users SET last_login = ? WHERE id = ?', [nowDateTime(), user.id]);
        await db.query(
            'INSERT INTO user_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
            [user.id, 'mobile_app_login', req.ip]
        );
        req.session.save((saveErr) => {
            if (saveErr) {
                console.error('App session save error:', saveErr);
                return res.status(500).json({ success: false, message: 'Unable to start mobile session.' });
            }
            return res.json({ success: true, user: req.session.user });
        });
    } catch (err) {
        console.error('App login error:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Mobile app logout (JSON)
router.post('/app-logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

module.exports = router;
