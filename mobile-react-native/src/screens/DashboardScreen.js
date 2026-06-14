import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '../api/client';

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function DashboardScreen({ user, onLogout, onOpenScanner }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [flags, setFlags] = useState([]);

  const load = useCallback(async (isRefresh = false, quiet = false) => {
    try {
      setError('');
      if (!quiet) {
        if (isRefresh) setRefreshing(true); else setLoading(true);
      }
      const [d, f] = await Promise.all([api.dashboard(today()), api.absenceFlags()]);
      setDashboard(d);
      setFlags(Array.isArray(f) ? f : []);
    } catch (err) {
      setError(err.message || 'Failed to load dashboard.');
    } finally {
      setLoading(false);
      if (!quiet) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      load(false, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
    >
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Welcome, {user.fullname || user.username}</Text>
        <Text style={styles.heroSub}>Attendance rate: {dashboard?.attendance_rate ?? 0}%</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.grid}>
        <Stat label="Students" value={dashboard?.total_students} />
        <Stat label="Present" value={dashboard?.students_present} />
        <Stat label="Absent" value={dashboard?.students_absent} />
        <Stat label="2-Day Flags" value={flags.length} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>2-Day Absence Alerts</Text>
        {flags.length === 0 ? <Text style={styles.small}>No alerts found.</Text> : flags.slice(0, 10).map((item) => (
          <Text key={`${item.person_type || 'student'}-${item.id}-${item.lrn || ''}-${item.grade_name || ''}-${item.section_name || ''}-${item.adviser_contact || item.school_contact || ''}`} style={styles.small}>
            {(item.name || `${item.firstname || ''} ${item.lastname || ''}`.trim())} - {item.grade_name || '-'} / {item.section_name || '-'} - {item.adviser_contact || item.adviser_email || item.school_contact || 'No contact'}
          </Text>
        ))}
      </View>

      <Pressable style={styles.primaryBtn} onPress={onOpenScanner}>
        <Text style={styles.primaryText}>Open QR Scanner</Text>
      </Pressable>

      <Pressable style={styles.secondaryBtn} onPress={onLogout}>
        <Text style={styles.secondaryText}>Logout</Text>
      </Pressable>
    </ScrollView>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statNum}>{value ?? 0}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hero: { backgroundColor: '#0f766e', borderRadius: 12, padding: 14 },
  heroTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  heroSub: { color: '#ccfbf1', marginTop: 4 },
  error: { color: '#b91c1c' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: { width: '48%', backgroundColor: '#fff', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#d7e2ef' },
  statNum: { fontWeight: '700', fontSize: 20, color: '#0f2f4f' },
  statLabel: { color: '#436281' },
  panel: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#d7e2ef', padding: 12, gap: 6 },
  panelTitle: { fontWeight: '700', color: '#0f2f4f' },
  small: { color: '#2e4f6f' },
  primaryBtn: { backgroundColor: '#1d4ed8', borderRadius: 10, padding: 13, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondaryBtn: { backgroundColor: '#fff', borderRadius: 10, padding: 13, alignItems: 'center', borderWidth: 1, borderColor: '#b8c8dc' },
  secondaryText: { color: '#1f3550', fontWeight: '700' }
});
