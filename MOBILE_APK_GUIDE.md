# Native SDS / ASDS Android APK

This repository now includes a native Android project at:

`mobile-sds-asds-android/`

It is separate from the Railway web app but runs the live web system inside a full-screen Android shell. The APK uses the same web login, same sessions, same Railway service, and same MySQL database, while applying mobile app styling inside the APK.

## What the APK does

- Full-screen Android WebView with no browser address bar.
- Uses the existing Railway/MySQL web system directly.
- Uses the same web login page and account database.
- Applies APK-only mobile styling so it feels like a native app.
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

After installing the APK, open it and sign in with the same web account. The app loads the configured Railway web app, MySQL database, and user accounts automatically.

## Server Connection

The APK reads the live server from `public/mobile-config.json`, then opens that Railway web system in a full-screen Android shell.

Current Railway URL:

`https://sdo-sipalay-website-production.up.railway.app`

## Notification Notes

Android requires notification permission on newer phones. The app asks for it during login.

Background checks run about every 15 minutes because Android controls background battery usage. Opening the app also refreshes the dashboard immediately.
