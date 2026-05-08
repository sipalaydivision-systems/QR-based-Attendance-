# School Attendance QR based Systems

A full-stack QR code attendance monitoring system built with **Node.js**, **Express**, **MySQL**, and **EJS**.

## Features

- **Role-based access control** (Super Admin, Principal, Superintendent, Asst. Superintendent)
- **Real-time dashboard** with attendance metrics and auto-polling
- **QR code scanning** via camera or manual entry
- **Student & Teacher management** with CRUD operations
- **Bulk CSV import** with duplicate detection and update-or-insert logic
- **QR code generation & printing** for students and teachers
- **Attendance reports** with CSV export
- **School management** with multi-school support
- **Offline detection** with retry overlay
- **Mobile-ready** responsive design (WebView compatible)
- **Railway deployment** ready

## Quick Start

### Prerequisites
- Node.js 18+
- MySQL 8+

### Setup

1. Clone the repository:
   ```bash
   git clone <your-repo-url>
   cd qr-attendance-system
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create your `.env` file:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your database credentials.

4. Import the database schema:
   ```bash
   mysql -u root -p < database/schema.sql
   ```

5. Seed the default admin user:
   ```bash
   node database/seed.js
   ```

6. Start the server:
   ```bash
   npm start
   ```

7. Open `http://localhost:3000` and log in with:
   - **Username:** `admin`
   - **Password:** `admin123`

## Railway Deployment

1. Push this repo to GitHub.
2. Connect your repo in Railway.
3. Add a MySQL service in Railway.
4. Set environment variables:
   - Either Railway's MySQL variables directly: `MYSQLHOST`, `MYSQLDATABASE`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLPORT`
   - Or map them to app variables: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_PORT`
   - `SESSION_SECRET` (random string)
   - `BASE_URL` (your Railway URL)
   - `NODE_ENV=production`
5. Deploy — Railway will auto-detect Node.js and run `node server.js`.

For a Railway web service connected to a Railway MySQL service, these app variables can be set as references:

```env
DB_HOST=${{MySQL.MYSQLHOST}}
DB_NAME=${{MySQL.MYSQLDATABASE}}
DB_USER=${{MySQL.MYSQLUSER}}
DB_PASS=${{MySQL.MYSQLPASSWORD}}
DB_PORT=${{MySQL.MYSQLPORT}}
```

## Project Structure

```
├── server.js              # Express app entry point
├── config/
│   └── database.js        # MySQL connection pool
├── middleware/
│   └── auth.js            # Auth & role-based access
├── routes/
│   ├── auth.js            # Login/logout/password
│   ├── api.js             # REST API endpoints
│   ├── admin.js           # Admin page routes
│   └── export.js          # CSV export & templates
├── database/
│   ├── schema.sql         # Full MySQL schema
│   └── seed.js            # Default admin seeder
├── views/                 # EJS templates
├── public/
│   ├── css/style.css      # Application styles
│   ├── js/                # Client-side scripts
│   └── templates/         # CSV import templates
├── railway.json           # Railway config
└── Procfile               # Process file
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/scan-attendance` | Record QR scan |
| GET | `/api/dashboard-data` | Dashboard statistics |
| GET | `/api/realtime-poll` | Lightweight change detection |
| GET/POST | `/api/students` | Student CRUD |
| GET/POST | `/api/teachers` | Teacher CRUD |
| GET/POST | `/api/schools` | School CRUD |
| GET | `/api/attendance` | Attendance records |
| GET | `/api/settings` | System settings |
| GET | `/export/report` | Export attendance CSV |
| GET | `/export/students` | Export student list |
| GET | `/export/not-scanned-today` | Export absent students |

## Default Credentials

- **Username:** `admin`
- **Password:** `admin123`

> Change the password after first login.
