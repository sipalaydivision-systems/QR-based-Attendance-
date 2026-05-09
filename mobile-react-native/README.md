# React Native Mobile App (Expo)

This folder contains the new React Native version of the attendance mobile app.

## Features included
- Railway API connection through `EXPO_PUBLIC_API_BASE_URL`
- Session-based login via `/app-login` and `/app-logout`
- Dashboard metrics from `/api/dashboard-data`
- 2-day absence alerts from `/api/absence-flags?days=2`
- QR scanner for `/api/scan-attendance`
- Notification polling every 15 minutes
- Web build support using Expo web export

## Configure server URL
Set your Railway URL before running:

```powershell
$env:EXPO_PUBLIC_API_BASE_URL="https://your-railway-domain.up.railway.app"
```

## Run locally
```powershell
cd mobile-react-native
npm install
npm run start
```

## Android APK build
```powershell
cd mobile-react-native
npm install
npm i -g eas-cli
eas login
eas build -p android --profile preview
```
This produces an installable `.apk` from EAS Build.

## Publish web version
```powershell
cd mobile-react-native
npm install
npm run web:build
```
Output is generated in `mobile-react-native/dist` and can be deployed to Railway static hosting, Vercel, or Netlify.

## Backend changes required
This repo now includes:
- `POST /app-logout` for mobile logout
- `GET /api/mobile-health` for mobile health checks