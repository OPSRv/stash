import { useCallback, useRef, useState } from 'react';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { Badge } from '../../shared/ui/Badge';
import { StatCard } from '../../shared/ui/StatCard';
import { RadialGauge } from './RadialGauge';
import { Sparkline } from './Sparkline';
import { dashboardMetrics, type DashboardMetrics, type NetIface } from './api';
import { formatBytes } from './format';
import { usePausedInterval } from './usePausedInterval';

const HISTORY = 40;
const POLL_MS = 1500;

const formatUptime = (sec: number): string => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}д ${h}г`;
  if (h > 0) return `${h}г ${m}хв`;
  return `${m}хв`;
};

/// Format per-second throughput. We stay in binary units for consistency
/// with `formatBytes` elsewhere — switching to decimal Mbps for the
/// network meter alone would confuse users comparing numbers across cards.
const formatRate = (bytesPerSec: number): string => `${formatBytes(Math.max(0, Math.round(bytesPerSec)))}/s`;

const IFACE_TINT: Record<NetIface['kind'], [string, string]> = {
  wifi: ['#8ec5ff', '#5561ff'],
  ethernet: ['#7ef7a5', '#17b26a'],
  vpn: ['#d08cff', '#7a4bff'],
  loopback: ['#5ee2c4', '#2aa3ff'],
  other: ['#5ee2c4', '#2aa3ff'],
};

const IFACE_LABEL: Record<NetIface['kind'], string> = {
  wifi: 'Wi-Fi',
  ethernet: 'Ethernet',
  vpn: 'VPN',
  loopback: 'Loopback',
  other: 'Мережа',
};

const WIFI_GLYPH =
  'M5 12a14 14 0 0 1 14 0M3 8a20 20 0 0 1 18 0M7 16a8 8 0 0 1 10 0';
const ETHERNET_GLYPH =
  'M3 7h18v8H3zM7 15v4M12 15v4M17 15v4';
const DEFAULT_GLYPH = 'M4 12h16';

type RateHistory = {
  rx: number[];
  tx: number[];
  rxRate: number;
  txRate: number;
};

const IfaceCard = ({
  iface,
  hist,
}: {
  iface: NetIface;
  hist: RateHistory | undefined;
}) => {
  const [c0, c1] = IFACE_TINT[iface.kind];
  const glyph =
    iface.kind === 'wifi'
      ? WIFI_GLYPH
      : iface.kind === 'ethernet'
      ? ETHERNET_GLYPH
      : DEFAULT_GLYPH;
  const header = (
    <span className="flex items-center gap-1.5">
      <span className="t-primary text-body font-semibold truncate">
        {IFACE_LABEL[iface.kind]}
      </span>
      {iface.is_primary && (
        <Badge tone="neutral" className="uppercase tracking-wider">primary</Badge>
      )}
      <span className="text-[10px] t-tertiary">{iface.name}</span>
    </span>
  );
  return (
    <StatCard
      gradient={[c0, c1]}
      icon={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d={glyph} />
        </svg>
      }
      eyebrow={header}
      value={
        <span className="flex items-center gap-3">
          <span className="min-w-0">
            <span className="block t-tertiary text-[10px]">↓ DOWN</span>
            <span className="t-primary text-body font-semibold">
              {hist ? formatRate(hist.rxRate) : '…'}
            </span>
          </span>
          <span className="min-w-0">
            <span className="block t-tertiary text-[10px]">↑ UP</span>
            <span className="t-primary text-body font-semibold">
              {hist ? formatRate(hist.txRate) : '…'}
            </span>
          </span>
        </span>
      }
      footer={
        hist && hist.rx.length >= 2 ? (
          <div className="flex items-center gap-1">
            <Sparkline values={hist.rx} color={c1} width={90} height={20} />
            <Sparkline values={hist.tx} color={c0} width={90} height={20} />
          </div>
        ) : null
      }
    />
  );
};

export const DashboardPanel = () => {
  const [m, setM] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  /// Per-interface byte history keyed by iface name. We store cumulative
  /// rx/tx since kernel boot (what `netstat` returns) plus a derived
  /// per-second rate computed as (current - previous) / seconds_elapsed.
  const ifaceHist = useRef<
    Map<string, { lastRx: number; lastTx: number; lastAt: number; rx: number[]; tx: number[]; rxRate: number; txRate: number }>
  >(new Map());
  // Suppress repeated alerts — once a threshold has fired we wait until
  // the metric recovers (goes back below 80% of the threshold) before we
  // let it fire again. Prevents "CPU 91%" from notifying every 1.5 s.
  const alertState = useRef<{ cpu: boolean; mem: boolean; disk: boolean; battery: boolean }>({
    cpu: false,
    mem: false,
    disk: false,
    battery: false,
  });
  const [, tick] = useState(0);

  const fireAlert = useCallback(async (title: string, body: string) => {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const req = await requestPermission();
        granted = req === 'granted';
      }
      if (granted) sendNotification({ title, body });
    } catch {
      /* non-fatal */
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const next = await dashboardMetrics();
      setM(next);
      cpuHist.current = [...cpuHist.current, next.cpu_percent].slice(-HISTORY);
      memHist.current = [
        ...memHist.current,
        next.mem_pressure_percent,
      ].slice(-HISTORY);

      // Derive per-second rate as the delta since the previous poll. We
      // clamp at zero to handle counter resets (e.g. Wi-Fi reconnect).
      const now = Date.now();
      for (const iface of next.interfaces) {
        const prev = ifaceHist.current.get(iface.name);
        if (prev) {
          const dt = Math.max(0.001, (now - prev.lastAt) / 1000);
          const rxRate = Math.max(0, (iface.rx_bytes - prev.lastRx) / dt);
          const txRate = Math.max(0, (iface.tx_bytes - prev.lastTx) / dt);
          ifaceHist.current.set(iface.name, {
            lastRx: iface.rx_bytes,
            lastTx: iface.tx_bytes,
            lastAt: now,
            rx: [...prev.rx, rxRate].slice(-HISTORY),
            tx: [...prev.tx, txRate].slice(-HISTORY),
            rxRate,
            txRate,
          });
        } else {
          ifaceHist.current.set(iface.name, {
            lastRx: iface.rx_bytes,
            lastTx: iface.tx_bytes,
            lastAt: now,
            rx: [],
            tx: [],
            rxRate: 0,
            txRate: 0,
          });
        }
      }
      // Drop stats for interfaces that vanished (e.g. Wi-Fi turned off).
      const live = new Set(next.interfaces.map((i) => i.name));
      for (const name of Array.from(ifaceHist.current.keys())) {
        if (!live.has(name)) ifaceHist.current.delete(name);
      }

      // Threshold-driven toasts — use macOS notification centre so the
      // user sees them even when Stash popup is closed. Each condition
      // gets a one-shot latch; recovery resets it so a flapping signal
      // doesn't notify every tick.
      if (next.cpu_percent >= 90 && !alertState.current.cpu) {
        alertState.current.cpu = true;
        fireAlert('CPU навантажено', `${next.cpu_percent.toFixed(0)}% · load ${next.load_1m.toFixed(2)}`);
      } else if (next.cpu_percent < 72) {
        alertState.current.cpu = false;
      }
      if (next.mem_pressure_percent >= 90 && !alertState.current.mem) {
        alertState.current.mem = true;
        fireAlert('RAM на межі', `Використано ${next.mem_pressure_percent.toFixed(0)}%`);
      } else if (next.mem_pressure_percent < 72) {
        alertState.current.mem = false;
      }
      if (next.disk_total_bytes > 0) {
        const freePct = (next.disk_free_bytes / next.disk_total_bytes) * 100;
        if (freePct < 10 && !alertState.current.disk) {
          alertState.current.disk = true;
          fireAlert('Диск майже повний', `Лишилось ${freePct.toFixed(0)}%`);
        } else if (freePct >= 15) {
          alertState.current.disk = false;
        }
      }
      if (
        next.battery_percent !== null &&
        next.battery_percent < 20 &&
        next.battery_charging === false &&
        !alertState.current.battery
      ) {
        alertState.current.battery = true;
        fireAlert('Батарея розряджається', `${next.battery_percent.toFixed(0)}%`);
      } else if (
        next.battery_percent === null ||
        next.battery_percent >= 30 ||
        next.battery_charging === true
      ) {
        alertState.current.battery = false;
      }

      tick((x) => x + 1);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [fireAlert]);
  usePausedInterval(poll, POLL_MS);

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <div className="t-primary text-title font-semibold">Огляд системи</div>
          <div className="t-tertiary text-meta">
            Живі метрики, оновлюються кожні 1.5 с
          </div>
        </div>
        {m && (
          <div className="t-tertiary text-meta tabular-nums">
            Uptime: <span className="t-secondary">{formatUptime(m.uptime_seconds)}</span>
          </div>
        )}
      </header>

      {error && <div className="t-danger text-body">Помилка: {error}</div>}

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
      >
        {/* CPU */}
        <div
          className="rounded-2xl p-3 relative overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(255,138,91,0.10), rgba(255,58,111,0.18))',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)',
          }}
        >
          <div className="flex items-center gap-3">
            <RadialGauge
              value={m ? Math.min(1, m.cpu_percent / 100) : 0}
              size={72}
              thickness={7}
              gradient={['#ff8a5b', '#ff3a6f']}
              glow="rgba(255,58,111,0.35)"
              label={m ? `${m.cpu_percent.toFixed(0)}%` : '…'}
              sublabel="CPU"
            />
            <div className="min-w-0 flex-1">
              <div className="t-tertiary text-meta">Load avg 1m</div>
              <div className="t-primary tabular-nums text-body font-semibold">
                {m ? m.load_1m.toFixed(2) : '—'}
              </div>
              <div className="mt-1">
                <Sparkline values={cpuHist.current} color="#ff5577" max={100} width={140} height={28} />
              </div>
            </div>
          </div>
        </div>

        {/* RAM */}
        <div
          className="rounded-2xl p-3 relative overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(142,197,255,0.10), rgba(85,97,255,0.18))',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)',
          }}
        >
          <div className="flex items-center gap-3">
            <RadialGauge
              value={
                m && m.mem_total_bytes > 0 ? m.mem_used_bytes / m.mem_total_bytes : 0
              }
              size={72}
              thickness={7}
              gradient={['#8ec5ff', '#5561ff']}
              glow="rgba(85,97,255,0.35)"
              label={m ? `${(m.mem_pressure_percent).toFixed(0)}%` : '…'}
              sublabel="RAM"
            />
            <div className="min-w-0 flex-1">
              <div className="t-tertiary text-meta">Використано</div>
              <div className="t-primary tabular-nums text-body font-semibold">
                {m ? formatBytes(m.mem_used_bytes) : '—'}
              </div>
              <div className="t-tertiary text-meta tabular-nums">
                з {m ? formatBytes(m.mem_total_bytes) : '—'}
              </div>
              <div className="mt-1">
                <Sparkline values={memHist.current} color="#8b94ff" max={100} width={140} height={28} />
              </div>
            </div>
          </div>
        </div>

        {/* Disk */}
        <div
          className="rounded-2xl p-3 relative overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(255,216,107,0.10), rgba(255,145,77,0.18))',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)',
          }}
        >
          <div className="flex items-center gap-3">
            <RadialGauge
              value={
                m && m.disk_total_bytes > 0 ? m.disk_used_bytes / m.disk_total_bytes : 0
              }
              size={72}
              thickness={7}
              gradient={['#ffd86b', '#ff914d']}
              glow="rgba(255,145,77,0.35)"
              label={
                m && m.disk_total_bytes > 0
                  ? `${((m.disk_used_bytes / m.disk_total_bytes) * 100).toFixed(0)}%`
                  : '…'
              }
              sublabel="Диск"
            />
            <div className="min-w-0 flex-1">
              <div className="t-tertiary text-meta">Використано</div>
              <div className="t-primary tabular-nums text-body font-semibold">
                {m ? formatBytes(m.disk_used_bytes) : '—'}
              </div>
              <div className="t-tertiary text-meta tabular-nums">
                з {m ? formatBytes(m.disk_total_bytes) : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Free disk — highlighted as a separate card so you can see at a
            glance how much headroom is left (used % alone doesn't tell you
            the absolute number). */}
        {m && (
          <div
            className="rounded-2xl p-3 relative overflow-hidden"
            style={{
              background:
                'linear-gradient(135deg, rgba(94,226,196,0.10), rgba(42,163,255,0.18))',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)',
            }}
          >
            <div
              aria-hidden
              className="absolute -top-6 -right-6 w-24 h-24 rounded-full"
              style={{
                background: 'radial-gradient(closest-side, rgba(42,163,255,0.4), transparent)',
                filter: 'blur(6px)',
              }}
            />
            <div className="relative">
              <div className="t-tertiary text-[10px] uppercase tracking-wider">
                Вільно на диску
              </div>
              <div className="t-primary text-title font-semibold mt-1 tabular-nums">
                {formatBytes(m.disk_free_bytes)}
              </div>
              <div className="t-tertiary text-meta tabular-nums">
                {m.process_count.toLocaleString()} процесів · load{' '}
                {m.load_1m.toFixed(2)} / {m.load_5m.toFixed(2)} / {m.load_15m.toFixed(2)}
              </div>
              <div className="t-tertiary text-meta tabular-nums mt-0.5">
                Ping 1.1.1.1:{' '}
                {m.ping_ms !== null ? (
                  <span
                    className="t-primary"
                    style={{
                      color:
                        m.ping_ms < 30
                          ? '#7ef7a5'
                          : m.ping_ms < 100
                          ? '#ffd86b'
                          : '#ff8080',
                    }}
                  >
                    {m.ping_ms.toFixed(1)} ms
                  </span>
                ) : (
                  <span className="t-tertiary">offline</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Battery */}
        {m && m.battery_percent !== null && (
          <div
            className="rounded-2xl p-3 relative overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(126,247,165,0.10), rgba(23,178,106,0.18))',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)',
            }}
          >
            <div className="flex items-center gap-3">
              <RadialGauge
                value={(m.battery_percent ?? 0) / 100}
                size={72}
                thickness={7}
                gradient={['#7ef7a5', '#17b26a']}
                glow="rgba(23,178,106,0.35)"
                label={`${(m.battery_percent ?? 0).toFixed(0)}%`}
                sublabel={m.battery_charging ? 'Заряджається' : 'Батарея'}
              />
              <div className="min-w-0 flex-1">
                <div className="t-tertiary text-meta">Стан</div>
                <div className="t-primary text-body font-semibold">
                  {m.battery_charging ? '⚡ Живлення' : '🔋 Розряджається'}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Live network cards — one per active Wi-Fi/Ethernet interface. We
          hide them entirely when the first poll hasn't finished so the
          user sees "Вільно…" placeholders only for the core 4 cards. */}
      {m && m.interfaces.length > 0 && (
        <>
          <div className="t-tertiary text-meta uppercase tracking-wider pt-1">
            Мережа
          </div>
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
          >
            {m.interfaces.map((iface) => (
              <IfaceCard
                key={iface.name}
                iface={iface}
                hist={ifaceHist.current.get(iface.name)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
