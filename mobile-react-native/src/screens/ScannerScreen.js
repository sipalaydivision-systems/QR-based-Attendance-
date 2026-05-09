import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { BarCodeScanner } from 'expo-barcode-scanner';
import { api } from '../api/client';

export default function ScannerScreen({ onBack }) {
  const [permission, setPermission] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Scan a student or teacher QR code.');

  useEffect(() => {
    (async () => {
      const result = await BarCodeScanner.requestPermissionsAsync();
      setPermission(result.status === 'granted');
    })();
  }, []);

  const onScanned = async ({ data }) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.scanAttendance(data);
      setMessage(result.message || result.error || 'Scanned successfully.');
    } catch (err) {
      setMessage(err.message || 'Scan failed.');
    } finally {
      setTimeout(() => setBusy(false), 1200);
    }
  };

  if (permission === null) {
    return <View style={styles.center}><ActivityIndicator /></View>;
  }

  if (permission === false) {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>Camera access is required.</Text>
        <Pressable style={styles.btn} onPress={onBack}><Text style={styles.btnText}>Back</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <BarCodeScanner onBarCodeScanned={onScanned} style={StyleSheet.absoluteFillObject} />
      <View style={styles.overlay}>
        <Text style={styles.message}>{message}</Text>
        <Pressable style={styles.btn} onPress={onBack}><Text style={styles.btnText}>Back</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  overlay: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.65)', padding: 16, gap: 12 },
  message: { color: '#fff', fontWeight: '600' },
  btn: { backgroundColor: '#1d4ed8', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700' }
});