import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type OrderPage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  ShopLayout,
  Notice,
  Pagination,
  StatusBadge,
  dateTime,
  rupiah,
} from '../components/ShopLayout';

export function OrdersPage() {
  const { token } = useAuth();
  const [data, setData] = useState<OrderPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!token) return;
    let active = true;
    setData(null);
    setError('');
    const query = new URLSearchParams({
      offset: String(offset),
      limit: '20',
      ...(status ? { status } : {}),
    });
    api
      .orders(token, query.toString())
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [token, offset, status, refresh]);
  return (
    <ShopLayout>
      <div className="page-heading">
        <div>
          <p className="eyebrow">AKUN ANDA</p>
          <h1>Riwayat pesanan</h1>
          <p className="text-muted mt-2">Pantau konfirmasi dan proses setiap pesanan.</p>
        </div>
        <button className="button-secondary" onClick={() => setRefresh((value) => value + 1)}>
          Muat ulang
        </button>
      </div>
      <label className="text-sm flex gap-3 items-center mb-6">
        Status pesanan
        <select
          className="field w-auto"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setOffset(0);
          }}
        >
          <option value="">Semua status</option>
          <option value="PENDING">Menunggu konfirmasi</option>
          <option value="CONFIRMED">Terkonfirmasi</option>
          <option value="FAILED">Ditolak</option>
          <option value="CANCELLATION_REQUESTED">Pembatalan diproses</option>
          <option value="CANCELLED">Dibatalkan</option>
        </select>
      </label>
      {error && <Notice error>{error}</Notice>}
      {!data && !error ? (
        <p role="status">Memuat pesanan...</p>
      ) : (
        data && (
          <>
            <div className="space-y-4">
              {!data.orders.length ? (
                <div className="panel text-center py-12">
                  <h2 className="text-xl text-primary font-semibold">Belum ada pesanan</h2>
                  <p className="text-muted my-3">
                    Pesanan dengan status yang dipilih akan tampil di sini.
                  </p>
                  <Link className="button-primary inline-flex" to="/dashboard">
                    Mulai belanja
                  </Link>
                </div>
              ) : (
                data.orders.map((order) => (
                  <article className="panel" key={order.id}>
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <p className="text-xs text-muted">{dateTime(order.createdAt)}</p>
                        <Link
                          to={`/orders/${order.id}`}
                          className="font-semibold text-primary block my-2 break-all"
                        >
                          #{order.id.slice(0, 8).toUpperCase()}
                        </Link>
                        <p className="text-sm text-muted">
                          {order.items.length
                            ? order.items
                                .map((item) => `${item.name} (${item.quantity})`)
                                .join(', ')
                            : 'Menunggu hasil reservasi produk'}
                        </p>
                      </div>
                      <div className="flex gap-2 items-start">
                        <StatusBadge status={order.status} />
                        {order.status === 'CONFIRMED' && (
                          <StatusBadge status={order.fulfillmentStatus} />
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between items-center border-t mt-5 pt-4">
                      <strong>{rupiah(order.total)}</strong>
                      <Link
                        to={`/orders/${order.id}`}
                        className="text-sm text-secondary font-medium underline"
                      >
                        Lihat detail
                      </Link>
                    </div>
                  </article>
                ))
              )}
            </div>
            <Pagination total={data.total} offset={offset} onChange={setOffset} />
          </>
        )
      )}
    </ShopLayout>
  );
}
