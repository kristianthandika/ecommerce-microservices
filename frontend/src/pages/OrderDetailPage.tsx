import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Order } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { ShopLayout, Notice, StatusBadge, dateTime, rupiah } from '../components/ShopLayout';

export function OrderDetailPage({ admin = false }: { admin?: boolean }) {
  const { id } = useParams();
  const { token } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!id || !token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setOrder(null);
    setError('');
    async function load() {
      try {
        const result = await api.order(id!, token!, admin);
        if (!active) return;
        setOrder(result.order);
        setError('');
        // Outcomes that the server completes in the background are polled.
        if (['PENDING', 'CANCELLATION_REQUESTED'].includes(result.order.status))
          timer = setTimeout(load, 4000);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Gagal memuat pesanan');
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, token, admin, refresh]);
  async function process(status: 'PROCESSING' | 'COMPLETED') {
    if (!order || !token || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.fulfillOrder(order.id, status, token);
      setOrder(result.order);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah status');
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!order || !token || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.cancelOrder(order.id, token, admin, reason);
      setOrder(result.order);
      setConfirming(false);
      setNotice(
        result.order.status === 'CANCELLED'
          ? 'Pesanan dibatalkan dan stok dikembalikan.'
          : 'Pembatalan dicatat. Stok dikembalikan otomatis begitu layanan produk tersedia.',
      );
      // Keep polling until the background release has finished.
      if (result.order.status === 'CANCELLATION_REQUESTED') setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membatalkan pesanan');
    } finally {
      setBusy(false);
    }
  }
  // Mirrors the server rule: customers until processing starts, admins until completion.
  const cancellable =
    !!order &&
    (order.status === 'PENDING' || order.status === 'CONFIRMED') &&
    (admin ? order.fulfillmentStatus !== 'COMPLETED' : order.fulfillmentStatus === 'NEW');
  return (
    <ShopLayout>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{admin ? 'OPERASIONAL ADMIN' : 'PESANAN ANDA'}</p>
          <h1>Detail pesanan</h1>
        </div>
        <Link className="button-secondary" to={admin ? '/admin' : '/orders'}>
          Kembali
        </Link>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {!order && !error ? (
        <p role="status">Memuat pesanan...</p>
      ) : (
        order && (
          <>
            <section className="panel mb-6">
              <div className="flex flex-wrap justify-between gap-4">
                <div>
                  <p className="font-semibold break-all text-primary">#{order.id}</p>
                  <p className="text-sm text-muted mt-2">{dateTime(order.createdAt)}</p>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <StatusBadge status={order.status} />
                  {order.status === 'CONFIRMED' && <StatusBadge status={order.fulfillmentStatus} />}
                </div>
              </div>
              <p className="text-sm mt-5 text-muted">
                {order.status === 'CONFIRMED'
                  ? 'Pesanan terkonfirmasi dan stok telah dialokasikan. Status ini belum menyatakan pembayaran diterima.'
                  : order.status === 'PENDING'
                    ? 'Konfirmasi sedang diproses. Sistem akan memeriksa dan memulihkan proses secara otomatis. Halaman diperbarui berkala.'
                    : order.status === 'CANCELLATION_REQUESTED'
                      ? 'Pembatalan sedang diproses. Stok dikembalikan otomatis; halaman diperbarui berkala.'
                      : order.status === 'CANCELLED'
                        ? 'Pesanan dibatalkan dan stok yang dialokasikan telah dikembalikan.'
                        : 'Pesanan ditolak. Tidak ada stok yang dialokasikan untuk pesanan ini.'}
              </p>
              {(order.status === 'CANCELLED' || order.status === 'CANCELLATION_REQUESTED') && (
                <p className="text-sm mt-2 text-muted">
                  Dibatalkan oleh {order.cancelledBy === 'admin' ? 'admin' : 'pelanggan'}
                  {order.cancelledAt ? ` pada ${dateTime(order.cancelledAt)}` : ''}
                  {order.cancelReason ? `. Alasan: ${order.cancelReason}` : ''}
                </p>
              )}
              <button
                className="button-secondary mt-4"
                onClick={() => setRefresh((value) => value + 1)}
              >
                Periksa status
              </button>
              {admin && order.status === 'CONFIRMED' && order.fulfillmentStatus !== 'COMPLETED' && (
                <button
                  className="button-primary ml-3 mt-4"
                  disabled={busy}
                  onClick={() =>
                    void process(order.fulfillmentStatus === 'NEW' ? 'PROCESSING' : 'COMPLETED')
                  }
                >
                  {busy
                    ? 'Menyimpan...'
                    : order.fulfillmentStatus === 'NEW'
                      ? 'Mulai proses pesanan'
                      : 'Tandai selesai'}
                </button>
              )}
              {cancellable && !confirming && (
                <button
                  className="button-secondary ml-3 mt-4 text-danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(true);
                    setNotice('');
                  }}
                >
                  Batalkan pesanan
                </button>
              )}
              {cancellable && confirming && (
                <div
                  className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4"
                  role="group"
                  aria-label="Konfirmasi pembatalan"
                >
                  <p className="text-sm text-red-800">
                    Batalkan pesanan ini? Stok yang sudah dialokasikan akan dikembalikan ke katalog.
                  </p>
                  <label className="block text-sm mt-3">
                    Alasan (opsional)
                    <textarea
                      className="field mt-2"
                      rows={2}
                      maxLength={200}
                      value={reason}
                      disabled={busy}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <div className="flex gap-3 mt-3">
                    <button
                      className="button-primary bg-danger hover:bg-red-700"
                      disabled={busy}
                      onClick={() => void cancel()}
                    >
                      {busy ? 'Membatalkan...' : 'Ya, batalkan'}
                    </button>
                    <button
                      className="button-secondary"
                      disabled={busy}
                      onClick={() => setConfirming(false)}
                    >
                      Kembali
                    </button>
                  </div>
                </div>
              )}
            </section>
            <div className="grid lg:grid-cols-[1fr_340px] gap-6">
              <section className="panel">
                <h2 className="text-lg font-semibold text-primary mb-4">Rincian produk</h2>
                {!order.items.length && (
                  <p className="text-muted text-sm">
                    Rincian harga tersedia setelah reservasi berhasil.
                  </p>
                )}
                <ul className="divide-y">
                  {order.items.map((item) => (
                    <li className="py-4 flex justify-between gap-3" key={item.productId}>
                      <div>
                        <h3 className="font-medium">{item.name}</h3>
                        <p className="text-sm text-muted mt-1">
                          {item.quantity} x {rupiah(item.unitPrice)}
                        </p>
                      </div>
                      <strong>{rupiah(item.subtotal)}</strong>
                    </li>
                  ))}
                </ul>
                <div className="border-t mt-4 pt-4 flex justify-between font-semibold text-lg text-primary">
                  <span>Total produk</span>
                  <span>{rupiah(order.total)}</span>
                </div>
              </section>
              <aside className="panel h-fit">
                <h2 className="text-lg font-semibold text-primary mb-4">Alamat penerima</h2>
                {order.shippingAddress ? (
                  <address className="not-italic text-sm leading-relaxed">
                    <strong>{order.shippingAddress.recipient}</strong>
                    <p className="mt-2">{order.shippingAddress.phone}</p>
                    <p className="mt-2">{order.shippingAddress.street}</p>
                    <p>
                      {order.shippingAddress.city}, {order.shippingAddress.province}{' '}
                      {order.shippingAddress.postalCode}
                    </p>
                    {order.shippingAddress.notes && (
                      <p className="mt-4 text-muted">Catatan: {order.shippingAddress.notes}</p>
                    )}
                  </address>
                ) : (
                  <p className="text-sm text-muted">
                    Pesanan ini dibuat tanpa alamat melalui alur sebelumnya.
                  </p>
                )}
              </aside>
            </div>
          </>
        )
      )}
    </ShopLayout>
  );
}
