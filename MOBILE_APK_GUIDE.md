# Native SDS / ASDS Android APK

This repository now includes a native Android project at:

`mobile-sds-asds-android/`

It is separate from the Railway web app. The APK signs in to the live server, shows only the SDS / ASDS division dashboard, and uses Android notifications for 2-day student absence alerts.

## What the APK does

- Native Android login screen for SDS and ASDS accounts only.
- Uses the existing Railway/MySQL system through:
  - `POST /app-login`
  - `GET /api/dashboard-data`
  - `GET /api/absence-flags?days=2`
- Stores the server session cookie on the phone.
- Shows dashboard totals for schools, students, teachers, present, absent, and 2-day absentees.
- Checks for 2-day absence flags in the background using Android WorkManager.
- Sends a phone notification when 2-day absentees are found.

## Build the APK

This machine needs Android Studio or a JDK + Android SDK to compile the APK.

1. Install Android Studio.
2. Open the folder `mobile-sds-asds-android`.
3. Wait for Gradle sync to finish.
4. Build APK:
   - Android Studio: `Build > Build Bundle(s) / APK(s) > Build APK(s)`
   - Terminal with Android tooling installed: `gradle assembleDebug`

The debug APK will be created under:

`mobile-sds-asds-android/app/build/outputs/apk/debug/`

## One-click download page

The web app has a public download page:

`/mobile-app`

The button downloads:

`/download/mobile-app`

GitHub Actions builds the Android APK and publishes it to:

`public/downloads/school-attendance-division.apk`

After the GitHub workflow finishes and Railway redeploys, users can open `/mobile-app` and tap `Download APK`.

After installing the APK, open `/mobile-app` again on the phone and tap `Connect App`. This sends the current web server URL into the native app so mobile login uses the same Railway web app, MySQL database, and user accounts.

## Server URL

The APK currently points to the Railway URL:

`https://web-production-5f74a.up.railway.app`

To change it, edit:

`mobile-sds-asds-android/app/src/main/res/values/strings.xml`

## Notification Notes

Android requires notification permission on newer phones. The app asks for it during login.

Background checks run about every 15 minutes because Android controls background battery usage. Opening the app also refreshes the dashboard immediately.
