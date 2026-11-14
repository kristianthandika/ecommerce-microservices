import type { ReactNode } from 'react';
import { Header } from './Header';
import { Footer } from './Footer';

export function ShopLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 w-full min-w-0 max-w-6xl mx-auto px-4 py-8 sm:py-10"
      >
        {children}
      </main>
      <Footer />
    </div>
  );
}
export const rupiah = (amount: number) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
export const dateTime = (date: string) =>
  new Date(date).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <p
      role={error ? 'alert' : 'status'}
      className={`rounded-xl px-4 py-3 text-sm mb-5 ${error ? 'bg-red-50 text-red-800 border border-red-200' : 'bg-green-50 text-green-800 border border-green-200'}`}
    >
      {children}
    </p>
  );
}
const badgeTone: Record<string, string> = {
  FAILED: 'bg-red-50 text-red-700',
  PENDING: 'bg-amber-50 text-amber-800',
  CANCELLATION_REQUESTED: 'bg-amber-50 text-amber-800',
  CANCELLED: 'bg-slate-100 text-slate-700',
};
export function StatusBadge({ status }: { status: string }) {
  const names: Record<string, string> = {
    PENDING: 'Menunggu konfirmasi',
    CONFIRMED: 'Terkonfirmasi',
    FAILED: 'Ditolak',
    CANCELLATION_REQUESTED: 'Pembatalan diproses',
    CANCELLED: 'Dibatalkan',
    NEW: 'Baru',
    PROCESSING: 'Diproses',
    COMPLETED: 'Selesai',
  };
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${badgeTone[status] ?? 'bg-blue-50 text-primary'}`}
    >
      {names[status] ?? status}
    </span>
  );
}
export function Pagination({
  offset,
  total,
  limit = 20,
  onChange,
}: {
  offset: number;
  total: number;
  limit?: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="flex justify-between items-center gap-3 mt-6 text-sm">
      <span className="text-muted">
        {total
          ? `${offset + 1}-${Math.min(offset + limit, total)} dari ${total}`
          : 'Belum ada data'}
      </span>
      <div className="flex gap-2">
        <button
          className="button-secondary"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Sebelumnya
        </button>
        <button
          className="button-secondary"
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          Berikutnya
        </button>
      </div>
    </div>
  );
}
