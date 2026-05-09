import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import ScannerScreen from './src/screens/ScannerScreen';
import { api, SESSION_COOKIE_KEY, USER_KEY } from './src/api/client';

export default function App() {
  const [booted, setBooted] = useState(false);
  const [user, setUser] = useState(null);
  const [screen, setScreen] = useState('dashboard');

  useEffect(() => {
    (async () => {
      const userRaw = await AsyncStorage.getItem(USER_KEY);
      if (userRaw) {
        setUser(JSON.parse(userRaw));
      }
      await Notifications.requestPermissionsAsync();
      setBooted(true);
    })();
  }, []);

  useEffect(() => {
    if (!user) return;
    const timer = setInterval(async () => {
      try {
        const flags = await api.getAbsenceFlags();
        if (Array.isArray(flags) && flags.length > 0) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: '2-Day Absence Alert',
              body: `${flags.length} students reached 2-day absence.`
            },
            trigger: null
          });
        }
      } catch (_err) {}
    }, 15 * 60 * 1000);

    return () => clearInterval(timer);
  }, [user]);

  const onLoggedIn = async (loginResult) => {
    setUser(loginResult.user);
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(loginResult.user));
    setScreen('dashboard');
  };

  const onLogout = async () => {
    try {
      await api.logout();
    } catch (_err) {}
    await AsyncStorage.multiRemove([SESSION_COOKIE_KEY, USER_KEY]);
    setUser(null);
  };

  const content = useMemo(() => {
    if (!user) {
      return <LoginScreen onLoggedIn={onLoggedIn} />;
    }
    if (screen === 'scanner') {
      return <ScannerScreen onBack={() => setScreen('dashboard')} />;
    }
    return <DashboardScreen user={user} onLogout={onLogout} onOpenScanner={() => setScreen('scanner')} />;
  }, [user, screen]);

  if (!booted) return <SafeAreaView style={styles.container} />;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.inner}>{content}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f3f8ff' },
  inner: { flex: 1 }
});