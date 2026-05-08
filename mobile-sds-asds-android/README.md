# School Attendance Division Android App

Native Android APK project for SDS and ASDS dashboard monitoring.

## Features

- Full-screen Android WebView shell for the live web system.
- Same web login, same sessions, same MySQL database.
- APK-only mobile styling for a native app feel.
- 2-day absence alert list.
- Android phone notifications for 2-day absence alerts.
- Background polling through WorkManager.

## Build

Open this folder in Android Studio, let Gradle sync, then use:

`Build > Build Bundle(s) / APK(s) > Build APK(s)`

Or from a terminal with Java, Gradle, and Android SDK installed:

```bash
gradle assembleDebug
```

## Configuration

The server URL is stored in:

`app/src/main/res/values/strings.xml`

The app reads `public/mobile-config.json` from GitHub and opens the configured Railway web system automatically.

The APK validates `/api/app-info` so it will not open another Railway website by mistake.
