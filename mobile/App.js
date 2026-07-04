import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';

/* ── Constants ── */
const KEY_URL    = '@sniperbot/server_url';
const KEY_SECRET = '@sniperbot/secret_key';
const REFRESH_INTERVAL_MS = 5000;

/* ── Color tokens ── */
const C = {
  bg:       '#0a0a0f',
  surface:  '#12121c',
  border:   '#252535',
  text:     '#d8d8f0',
  muted:    '#6b6b8f',
  green:    '#00d68f',
  red:      '#ff4d6a',
  yellow:   '#f0b90b',
  blue:     '#4d9eff',
};

/* ── Utility functions ── */
function fmt(n, digits = 4) {
  if (n == null) return '—';
  return Number(n).toFixed(digits);
}
function fmtPct(n) {
  if (n == null) return '—';
  return (Number(n) * 100).toFixed(2) + '%';
}
function fmtMs(ms) {
  if (!ms || ms <= 0) return '0h 0m';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

/* ─────────────────────────────────────────────────────────────
   Settings Screen
───────────────────────────────────────────────────────────── */
function SettingsScreen({ onConnect }) {
  const [url, setUrl]       = useState('http://192.168.1.x:3000');
  const [key, setKey]       = useState('');
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const savedUrl = await AsyncStorage.getItem(KEY_URL);
      const savedKey = await AsyncStorage.getItem(KEY_SECRET);
      if (savedUrl) setUrl(savedUrl);
      if (savedKey) setKey(savedKey);
    })();
  }, []);

  async function handleConnect() {
    const trimUrl = url.trim().replace(/\/$/, '');
    const trimKey = key.trim();
    if (!trimUrl) { setError('Server URL is required.'); return; }
    setError('');
    setLoading(true);
    try {
      const headers = {};
      if (trimKey) headers['x-secret-key'] = trimKey;
      const res = await fetch(`${trimUrl}/summary`, { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await AsyncStorage.setItem(KEY_URL, trimUrl);
      await AsyncStorage.setItem(KEY_SECRET, trimKey);
      const data = await res.json();
      onConnect({ serverUrl: trimUrl, secretKey: trimKey, data });
    } catch (e) {
      setError('Connection failed: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={[s.flex1, s.bgBase]}>
      <StatusBar style="light" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.flex1}>
        <ScrollView contentContainerStyle={s.settingsContainer} keyboardShouldPersistTaps="handled">
          <Text style={s.settingsTitle}>🎯 SniperBot</Text>
          <Text style={s.settingsSubtitle}>Connect to your bot's dashboard API</Text>

          <View style={s.card}>
            <Text style={s.fieldLabel}>SERVER URL</Text>
            <TextInput
              style={s.input}
              value={url}
              onChangeText={setUrl}
              placeholder="http://192.168.1.x:3000"
              placeholderTextColor={C.muted}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={s.hint}>Use your machine's local IP so Expo Go can reach it</Text>
          </View>

          <View style={s.card}>
            <Text style={s.fieldLabel}>SECRET KEY</Text>
            <TextInput
              style={s.input}
              value={key}
              onChangeText={setKey}
              placeholder="value of DASHBOARD_SECRET_KEY"
              placeholderTextColor={C.muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={s.hint}>Set with DASHBOARD_SECRET_KEY=… when starting the bot</Text>
          </View>

          {!!error && (
            <View style={s.errorBox}>
              <Text style={s.errorText}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[s.btn, s.btnPrimary, loading && s.btnDisabled]}
            onPress={handleConnect}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={s.btnPrimaryText}>Connect →</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ─────────────────────────────────────────────────────────────
   Dashboard Screen
───────────────────────────────────────────────────────────── */
function DashboardScreen({ serverUrl, secretKey, initialData, onDisconnect }) {
  const [data, setData]         = useState(initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]       = useState('');
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const timerRef = useRef(null);

  const fetchData = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    try {
      const headers = {};
      if (secretKey) headers['x-secret-key'] = secretKey;
      const res = await fetch(`${serverUrl}/summary`, { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      setError('');
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }, [serverUrl, secretKey]);

  useEffect(() => {
    timerRef.current = setInterval(() => fetchData(false), REFRESH_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [fetchData]);

  if (!data) {
    return (
      <SafeAreaView style={[s.flex1, s.bgBase, s.center]}>
        <ActivityIndicator color={C.blue} size="large" />
      </SafeAreaView>
    );
  }

  const gs  = data.goalStatus;
  const sh  = data.strategyHealth || {};
  const variants  = data.variantSummary || [];
  const positions = data.openPositions  || [];
  const logs      = [...(data.recentLogs || [])].reverse();
  const pnl       = data.realizedPnlSol ?? 0;

  return (
    <SafeAreaView style={[s.flex1, s.bgBase]}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>🎯 SniperBot</Text>
        <View style={s.headerRight}>
          <View style={[s.dot, error ? s.dotRed : s.dotGreen]} />
          <Text style={s.headerSub}>{error ? 'Error' : `${lastUpdated.toLocaleTimeString()}`}</Text>
          <TouchableOpacity onPress={onDisconnect} style={s.btnSmall}>
            <Text style={s.btnSmallTxt}>⚙</Text>
          </TouchableOpacity>
        </View>
      </View>

      {!!error && (
        <View style={s.errorBox}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={s.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchData(true)}
            tintColor={C.blue}
          />
        }
      >
        {/* Goal Progress */}
        <View style={s.card}>
          <Text style={s.cardLabel}>GOAL PROGRESS · 0.1 → 2.0 SOL</Text>
          {gs ? (
            <>
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${Math.min(1, gs.progress || 0) * 100}%` }]} />
              </View>
              <View style={s.rowBetween}>
                <Text style={[s.monoLg, { color: C.green }]}>{fmt(gs.equity, 4)} SOL</Text>
                <Text style={[s.monoLg, { color: C.blue }]}>{((gs.progress || 0) * 100).toFixed(1)}%</Text>
              </View>
              <Text style={s.muted}>
                {gs.stop
                  ? (gs.achieved ? '🏁 Goal achieved!' : '⏰ Time expired')
                  : `${fmtMs(gs.timeRemainingMs)} remaining`}
              </Text>
            </>
          ) : (
            <Text style={s.muted}>Goal agent not configured</Text>
          )}
        </View>

        {/* Metrics Row */}
        <View style={s.row3}>
          <View style={[s.card, s.flex1]}>
            <Text style={s.cardLabel}>BANKROLL</Text>
            <Text style={s.monoLg}>{fmt(data.bankrollSol, 4)}</Text>
            <Text style={s.muted}>SOL</Text>
          </View>
          <View style={[s.card, s.flex1]}>
            <Text style={s.cardLabel}>REALIZED PnL</Text>
            <Text style={[s.monoLg, { color: pnl >= 0 ? C.green : C.red }]}>
              {(pnl >= 0 ? '+' : '') + fmt(pnl, 4)}
            </Text>
            <Text style={s.muted}>SOL</Text>
          </View>
          <View style={[s.card, s.flex1]}>
            <Text style={s.cardLabel}>CIRCUIT</Text>
            <Text style={[s.monoLg, { color: sh.circuitBreaker ? C.red : C.green }]}>
              {sh.circuitBreaker ? 'ACTIVE' : 'OFF'}
            </Text>
          </View>
        </View>

        {/* Risk Row */}
        <View style={s.row2}>
          <View style={[s.card, s.flex1]}>
            <Text style={s.cardLabel}>DRAWDOWN</Text>
            <View style={s.riskTrack}>
              <View style={[
                s.riskFill,
                { width: `${Math.min((sh.drawdownPct || 0) / 0.15 * 100, 100)}%` },
                (sh.drawdownPct || 0) >= 0.12 && { backgroundColor: C.red },
                (sh.drawdownPct || 0) >= 0.08 && (sh.drawdownPct || 0) < 0.12 && { backgroundColor: C.yellow },
              ]} />
            </View>
            <Text style={s.monoMd}>{fmtPct(sh.drawdownPct)}</Text>
            <Text style={s.muted}>max 15%</Text>
          </View>
          <View style={[s.card, s.flex1]}>
            <Text style={s.cardLabel}>DAILY LOSS</Text>
            <View style={s.riskTrack}>
              <View style={[
                s.riskFill,
                { width: `${Math.min((sh.dailyLossPct || 0) / 0.10 * 100, 100)}%` },
                (sh.dailyLossPct || 0) >= 0.08 && { backgroundColor: C.red },
                (sh.dailyLossPct || 0) >= 0.05 && (sh.dailyLossPct || 0) < 0.08 && { backgroundColor: C.yellow },
              ]} />
            </View>
            <Text style={s.monoMd}>{fmtPct(sh.dailyLossPct)}</Text>
            <Text style={s.muted}>max 10%</Text>
          </View>
        </View>

        {/* Strategy Variants */}
        {variants.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardLabel}>STRATEGY VARIANTS</Text>
            {variants.map((v, i) => {
              const total = (v.wins || 0) + (v.losses || 0);
              const wr = total > 0 ? ((v.wins / total) * 100).toFixed(0) + '%' : '—';
              return (
                <View key={v.name} style={[s.variantRow, i > 0 && s.borderTop]}>
                  <View style={s.flex1}>
                    <Text style={[s.variantName, i === 0 && { color: C.yellow }]}>
                      {i === 0 ? '★ ' : ''}{v.name}
                    </Text>
                    <Text style={s.muted}>{v.wins || 0}W / {v.losses || 0}L · {wr}</Text>
                  </View>
                  <Text style={[s.monoMd, { color: (v.equity || 0) > 0.1 ? C.green : C.muted }]}>
                    {fmt(v.equity, 4)} SOL
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Open Positions */}
        <View style={s.card}>
          <Text style={s.cardLabel}>OPEN POSITIONS ({positions.length})</Text>
          {positions.length === 0
            ? <Text style={s.muted}>No open positions</Text>
            : positions.map((p, i) => (
                <View key={i} style={[s.posRow, i > 0 && s.borderTop]}>
                  <Text style={[s.monoSm, { color: C.blue }]}>{p.pair || '—'}</Text>
                  <Text style={s.muted}>
                    entry {fmt(p.entryPrice, 4)} · {fmt(p.capitalSol, 4)} SOL · {p.venue || '—'}
                  </Text>
                </View>
              ))
          }
        </View>

        {/* Recent Logs */}
        <View style={s.card}>
          <Text style={s.cardLabel}>RECENT LOGS</Text>
          {logs.length === 0
            ? <Text style={s.muted}>No logs yet</Text>
            : logs.slice(0, 30).map((log, i) => {
                const ts = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '—';
                const type = log.type || 'info';
                let body = '';
                if (log.decision) {
                  body = `[${log.decision.action || '—'}] ${log.opportunity?.pair || ''} ${log.decision.reason || ''}`.trim();
                } else if (log.execution) {
                  const ex = log.execution;
                  const pnlStr = ex.pnlSol != null ? (ex.pnlSol >= 0 ? '+' : '') + fmt(ex.pnlSol, 4) + ' SOL' : '—';
                  body = `[${(log.kind || 'EXEC').toUpperCase()}] ${log.opportunity?.pair || log.position?.pair || ''} pnl: ${pnlStr}`.trim();
                } else {
                  body = JSON.stringify(log).slice(0, 80);
                }
                return (
                  <View key={i} style={[s.logRow, i > 0 && s.borderTop]}>
                    <Text style={s.logTs}>{ts}</Text>
                    <Text style={[s.logType, type === 'execution' && { color: C.blue }]}>{type.toUpperCase()}</Text>
                    <Text style={[s.monoSm, s.flex1]}>{body}</Text>
                  </View>
                );
              })
          }
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ─────────────────────────────────────────────────────────────
   Root App
───────────────────────────────────────────────────────────── */
export default function App() {
  const [conn, setConn] = useState(null);

  const handleConnect = ({ serverUrl, secretKey, data }) => {
    setConn({ serverUrl, secretKey, data });
  };
  const handleDisconnect = () => setConn(null);

  if (!conn) {
    return <SettingsScreen onConnect={handleConnect} />;
  }
  return (
    <DashboardScreen
      serverUrl={conn.serverUrl}
      secretKey={conn.secretKey}
      initialData={conn.data}
      onDisconnect={handleDisconnect}
    />
  );
}

/* ─────────────────────────────────────────────────────────────
   Styles
───────────────────────────────────────────────────────────── */
const s = StyleSheet.create({
  flex1:    { flex: 1 },
  bgBase:   { backgroundColor: C.bg },
  center:   { alignItems: 'center', justifyContent: 'center' },

  /* Header */
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.bg,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: C.text },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerSub:   { fontSize: 11, color: C.muted },
  dot:  { width: 8, height: 8, borderRadius: 4 },
  dotGreen: { backgroundColor: C.green },
  dotRed:   { backgroundColor: C.red },

  /* Scroll */
  scrollContent: { padding: 12, gap: 10 },

  /* Card */
  card: {
    backgroundColor: C.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 6,
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: C.muted,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  /* Progress */
  progressTrack: {
    height: 8,
    backgroundColor: '#1e1e30',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: C.blue,
    borderRadius: 4,
  },

  /* Risk bar */
  riskTrack: {
    height: 5,
    backgroundColor: '#1e1e30',
    borderRadius: 3,
    overflow: 'hidden',
  },
  riskFill: {
    height: '100%',
    backgroundColor: C.blue,
    borderRadius: 3,
  },

  /* Layout helpers */
  row3: { flexDirection: 'row', gap: 10 },
  row2: { flexDirection: 'row', gap: 10 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },

  /* Typography */
  monoLg: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 20, fontWeight: '700', color: C.text },
  monoMd: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 16, fontWeight: '600', color: C.text },
  monoSm: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, color: C.text },
  muted:  { fontSize: 12, color: C.muted },

  /* Variant row */
  variantRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 8 },
  variantName: { fontSize: 13, fontWeight: '600', color: C.text },
  borderTop: { borderTopWidth: 1, borderTopColor: C.border },

  /* Position row */
  posRow: { paddingVertical: 8, gap: 3 },

  /* Log row */
  logRow: { flexDirection: 'row', paddingVertical: 6, gap: 8, alignItems: 'flex-start' },
  logTs:   { fontSize: 10, color: C.muted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', width: 72 },
  logType: { fontSize: 9, fontWeight: '700', color: C.muted, width: 58, textTransform: 'uppercase', letterSpacing: 0.5, paddingTop: 1 },

  /* Settings */
  settingsContainer: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 14 },
  settingsTitle:    { fontSize: 28, fontWeight: '800', color: C.text, textAlign: 'center' },
  settingsSubtitle: { fontSize: 14, color: C.muted, textAlign: 'center', marginBottom: 8 },
  fieldLabel: { fontSize: 10, fontWeight: '700', color: C.muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  input: {
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    color: C.text,
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  hint: { fontSize: 11, color: C.muted, marginTop: 4 },

  /* Error */
  errorBox: {
    backgroundColor: 'rgba(255,77,106,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,77,106,0.35)',
    borderRadius: 8,
    padding: 10,
    marginHorizontal: 12,
    marginBottom: 4,
  },
  errorText: { color: C.red, fontSize: 13 },

  /* Buttons */
  btn: {
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  btnPrimary:     { backgroundColor: C.blue },
  btnDisabled:    { opacity: 0.6 },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  btnSmall: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  btnSmallTxt: { color: C.text, fontSize: 14 },
});
