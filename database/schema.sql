-- Edutrack Database Schema
-- MySQL
-- Run this inside the configured application database.

-- -----------------------------------------------------------
-- Schools
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS schools (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    school_id_code VARCHAR(50) UNIQUE,
    school_code VARCHAR(20) UNIQUE,
    address VARCHAR(500),
    contact VARCHAR(100),
    logo MEDIUMTEXT,
    status ENUM('active','inactive') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Grade Levels
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS grade_levels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    school_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Sections
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS sections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    grade_level_id INT,
    school_id INT,
    adviser VARCHAR(255),
    adviser_teacher_id INT,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_level_id) REFERENCES grade_levels(id) ON DELETE SET NULL,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Admin Users
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    fullname VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    contact VARCHAR(50),
    profile_photo MEDIUMTEXT,
    role ENUM('super_admin','principal','superintendent','asst_superintendent','adviser','parent') NOT NULL DEFAULT 'principal',
    teacher_id INT,
    school_id INT,
    status ENUM('active','inactive') DEFAULT 'active',
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    push_token VARCHAR(255) NOT NULL,
    platform VARCHAR(20),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_user_device_token (push_token),
    INDEX idx_user_devices_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_push_deliveries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    delivery_key VARCHAR(191) NOT NULL,
    user_id INT NOT NULL,
    notification_type VARCHAR(60) NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_system_push_delivery (delivery_key),
    INDEX idx_system_push_user (user_id, sent_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Parent / Guardian Accounts
-- -----------------------------------------------------------
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
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Students
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    lrn VARCHAR(50) UNIQUE,
    firstname VARCHAR(255) NOT NULL,
    lastname VARCHAR(255) NOT NULL,
    middlename VARCHAR(255),
    gender ENUM('Male','Female','Other'),
    birthdate DATE,
    grade_level_id INT,
    section_id INT,
    school_id INT NOT NULL,
    guardian_name VARCHAR(255),
    guardian_contact VARCHAR(100),
    qr_code VARCHAR(100) UNIQUE,
    active_from DATE,
    status ENUM('active','inactive','deleted') DEFAULT 'inactive',
    category ENUM('student','shs_student') DEFAULT 'student',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_level_id) REFERENCES grade_levels(id) ON DELETE SET NULL,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE,
    INDEX idx_students_school (school_id),
    INDEX idx_students_qr (qr_code),
    INDEX idx_students_status (status)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Teachers
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS teachers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_id VARCHAR(50) UNIQUE,
    firstname VARCHAR(255) NOT NULL,
    lastname VARCHAR(255) NOT NULL,
    middlename VARCHAR(255),
    department VARCHAR(255),
    subject VARCHAR(255),
    contact VARCHAR(100),
    email VARCHAR(255),
    password VARCHAR(255),
    grade_level_id INT,
    section_id INT,
    school_id INT NOT NULL,
    qr_code VARCHAR(100) UNIQUE,
    active_from DATE,
    status ENUM('active','inactive','deleted') DEFAULT 'inactive',
    category ENUM('teacher','shs_teacher') DEFAULT 'teacher',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE,
    FOREIGN KEY (grade_level_id) REFERENCES grade_levels(id) ON DELETE SET NULL,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL,
    INDEX idx_teachers_school (school_id),
    INDEX idx_teachers_section (section_id),
    INDEX idx_teachers_qr (qr_code)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Attendance
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
    id INT AUTO_INCREMENT PRIMARY KEY,
    person_type ENUM('student','teacher') NOT NULL,
    person_id INT NOT NULL,
    school_id INT NOT NULL,
    date DATE NOT NULL,
    time_in DATETIME,
    last_time_in DATETIME,
    time_out DATETIME,
    status ENUM('present','late','half_day','absent') DEFAULT 'present',
    monitoring_status VARCHAR(20) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE,
    UNIQUE KEY unique_attendance (person_type, person_id, date),
    INDEX idx_attendance_date (date),
    INDEX idx_attendance_school_date (school_id, date)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Attendance Events (full time-in/time-out transaction log)
-- -----------------------------------------------------------
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
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- User Activity Logs
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    action VARCHAR(255) NOT NULL,
    details TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- SMS Logs
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    recipient VARCHAR(100),
    message TEXT,
    status ENUM('sent','failed','pending') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255),
    message TEXT,
    type VARCHAR(50),
    school_id INT,
    grade_level_id INT,
    section_id INT,
    student_id INT,
    target_audience VARCHAR(50) DEFAULT 'school',
    attachment_url MEDIUMTEXT,
    created_by INT,
    created_by_name VARCHAR(255),
    created_by_role VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Parent Device Tokens
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    parent_id INT NOT NULL,
    contact_number VARCHAR(100),
    normalized_contact VARCHAR(30),
    device_token VARCHAR(255) NOT NULL,
    push_token TEXT,
    platform VARCHAR(50) DEFAULT 'android',
    app_version VARCHAR(50),
    user_agent TEXT,
    last_seen_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_parent_device_token (device_token),
    INDEX idx_parent_devices_parent (parent_id),
    INDEX idx_parent_devices_contact (normalized_contact),
    FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Parent Notification Inbox
-- -----------------------------------------------------------
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
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Push Subscriptions
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    endpoint TEXT NOT NULL,
    p256dh VARCHAR(255),
    auth VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Settings
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value MEDIUMTEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Events
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    event_date DATE NOT NULL,
    school_id INT,
    status ENUM('active','cancelled') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Event Attendance
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_attendance (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id INT NOT NULL,
    person_type ENUM('student','teacher') NOT NULL,
    person_id INT NOT NULL,
    school_id INT,
    time_in DATETIME,
    time_out DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL,
    UNIQUE KEY unique_event_att (event_id, person_type, person_id)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- School Days Calendar
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS school_days (
    id INT AUTO_INCREMENT PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    is_school_day TINYINT(1) DEFAULT 1,
    reason VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Holidays
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS holidays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    holiday_date DATE NOT NULL,
    name VARCHAR(255) NOT NULL,
    school_id INT DEFAULT NULL,
    is_national TINYINT(1) DEFAULT 1,
    notification_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL,
    UNIQUE KEY unique_holiday_date_school (holiday_date, school_id),
    INDEX idx_holiday_date (holiday_date)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Section Transfer / Reassignment Requests (approval workflow)
-- -----------------------------------------------------------
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
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- School Years (yearly cycle — exactly one 'active' at a time)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS school_years (
    id INT AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(20) NOT NULL UNIQUE,
    start_date DATE NULL,
    end_date DATE NULL,
    status ENUM('upcoming','active','closed') DEFAULT 'upcoming',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_school_years_status (status)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Student Enrollments (per-student, per-school-year history).
-- The 5 enrollment statuses live on this table. students.status stays the
-- attendance-eligibility flag (active/inactive/deleted) for the active year.
-- -----------------------------------------------------------
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
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- Seed Data
-- -----------------------------------------------------------

-- Default super admin (password: admin123)
-- Password hash will be generated by the app's seed script
INSERT INTO settings (setting_key, setting_value) VALUES
('system_name', 'Edutrack'),
('division_name', 'Schools Division of Sipalay City'),
('school_year', '2025-2026'),
('late_time', '08:00:00'),
('absent_time', '10:00:00'),
('am_time_in_end', '07:00:00'),
('am_late_time', '07:15:00'),
('late_threshold', '15'),
('lunch_break_start', '11:00:00'),
('pm_time_in_start', '13:00:00'),
('pm_late_time', '13:15:00'),
('pm_time_out_end', '16:00:00'),
('absence_cutoff_time', '16:00:00'),
('teacher_duty_end_time', '16:00:00'),
('auto_activate_on_scan', '1')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
