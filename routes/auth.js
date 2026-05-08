const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const db = require('../config/database');

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
            school_id: user.school_id
        };
        // Update last login
        await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
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
        return res.json({ success: true, user: req.session.user });
    } catch (err) {
        console.error('App login error:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
