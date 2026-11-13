import { useEffect, useState } from 'react';
import { api, type HealthResponse } from '../api/client';

const POLL_INTERVAL_MS = 3000;

/**
 * Live service-health widget (m4.2): polling `/health` gateway tiap beberapa
 * detik, menampilkan status tiap service dengan indikator warna brand
 * (success = up, danger = down).
 */
export function HealthWidget() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>('');

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function tick() {
      const data = await api.health(controller.signal);
      if (!active) return;
      setHealth(data);
      setUpdatedAt(new Date().toLocaleTimeString('id-ID'));
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
    tick();

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  const services = health?.services ?? {};
  const names = Object.keys(services);

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-primary">Status Layanan</h2>
        <span
          className={`text-xs font-medium px-2 py-1 rounded-full ${
            health?.status === 'ok' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
          }`}
        >
          {health ? (health.status === 'ok' ? 'Semua normal' : 'Ada gangguan') : 'Memuat…'}
        </span>
      </div>

      <ul className="space-y-2">
        <ServiceRow name="gateway" status={health ? (health.gateway as 'up') : undefined} />
        {names.map((name) => (
          <ServiceRow key={name} name={name} status={services[name]} />
        ))}
      </ul>

      {updatedAt && (
        <p className="mt-4 text-xs text-muted">
          Diperbarui otomatis tiap {POLL_INTERVAL_MS / 1000}s · terakhir {updatedAt}
        </p>
      )}
    </section>
  );
}

function ServiceRow({ name, status }: { name: string; status?: 'up' | 'down' }) {
  const up = status === 'up';
  return (
    <li className="flex items-center justify-between py-1">
      <span className="capitalize text-sm text-ink">{name}</span>
      <span className="flex items-center gap-2 text-sm">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: up ? 'var(--color-success)' : 'var(--color-danger)' }}
          aria-hidden
        />
        <span style={{ color: up ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {status ? (up ? 'UP' : 'DOWN') : '—'}
        </span>
      </span>
    </li>
  );
}
