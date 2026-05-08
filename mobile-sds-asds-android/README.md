# School Attendance Division Android App

Native Android APK project for SDS and ASDS dashboard monitoring.

## Features

- SDS / ASDS login only.
- Native dashboard cards backed by the Railway server.
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

Current value:

`https://web-production-5f74a.up.railway.app`
