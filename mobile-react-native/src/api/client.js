import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const SESSION_COOKIE_KEY = 'mobile_session_cookie';
export const USER_KEY = 'mobile_user';

const extraBase = Constants.expoConfig?.extra?.apiBaseUrl || '';
const envBase = process.env.EXPO_PUBLIC_API_BASE_URL || '';
const defaultBase = envBase || extraBase;

function normalize(url) {
  return (url || '').replace(/\/+$/, '');
}

async function resolveBaseUrl() {
  const manual = normalize(defaultBase);
  if (manual) return manual;
  return '';
}

async function request(path, options = {}) {
  const base = await resolveBaseUrl();
  if (!base) {
    throw new Error('API base URL is not configured. Set EXPO_PUBLIC_API_BASE_URL.');
  }

  const cookie = await AsyncStorage.getItem(SESSION_COOKIE_KEY);
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (cookie) {
    headers.Cookie = cookie;
  }

  const response = await fetch(`${base}${path}`, {
    ...options,
    headers
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const parsed = setCookie.split(';')[0];
    await AsyncStorage.setItem(SESSION_COOKIE_KEY, parsed);
  }

  let payload = null;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_err) {
    payload = text;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || 'Request failed';
    throw new Error(message);
  }

  return payload;
}

export const api = {
  login: async (username, password) => request('/app-login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  }),
  logout: async () => request('/app-logout', { method: 'POST' }),
  appInfo: async () => request('/api/app-info'),
  dashboard: async (date) => request(`/api/dashboard-data?date=${encodeURIComponent(date)}`),
  absenceFlags: async () => request('/api/absence-flags?days=2'),
  getAbsenceFlags: async () => request('/api/absence-flags?days=2'),
  scanAttendance: async (qr_code) => request('/api/scan-attendance', {
    method: 'POST',
    body: JSON.stringify({ qr_code })
  })
};