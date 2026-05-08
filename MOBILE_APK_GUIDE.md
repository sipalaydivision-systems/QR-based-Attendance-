# QR Attendance Mobile App (APK) Guide

This project is now prepared as an installable mobile web app (PWA) with:
- Realtime dashboard polling
- Phone notifications for new 2-day absence flags
- Mobile-first UI improvements

## 1) Run in production-style mode

1. Host this app on HTTPS (required for full PWA + notifications on phones).
2. Open it on Android Chrome.
3. Login as `super_admin`, `superintendent`, or `asst_superintendent`.

## 2) Install on phone (PWA)

1. In Chrome Android: open menu.
2. Tap `Install app` / `Add to Home screen`.
3. Open from app icon for full-screen app behavior.

## 3) Build Android APK (Trusted Web Activity)

Use Bubblewrap (official TWA tooling):

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://YOUR_DOMAIN/manifest.webmanifest
bubblewrap build
```

The generated Android project can then be opened in Android Studio and built as APK:

1. Open generated project in Android Studio.
2. Build > Build Bundle(s) / APK(s) > Build APK(s).

## 4) Notes for alerts

- Alerts are triggered when app detects newly flagged 2-day absences.
- User must allow notifications.
- Best reliability requires HTTPS and opening app from installed icon.

