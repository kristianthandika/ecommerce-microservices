import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type Product,
  type OrderPage,
  type OrderSummary,
  type ProductSummary,
} from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  ShopLayout,
  Notice,
  Pagination,
  StatusBadge,
  rupiah,
  dateTime,
} from '../components/ShopLayout';

const blank = { name: '', price: '', stock: '' };
export function AdminPage() {
  const { token } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'orders' ? 'orders' : 'products';
  const [products, setProducts] = useState<Product[]>([]);
  const [productTotal, setProductTotal] = useState(0);
  const [orders, setOrders] = useState<OrderPage | null>(null);
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [stock, setStock] = useState<ProductSummary | null>(null);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!token) return;
    let active = true;
    Promise.all([api.orderSummary(token), api.productSummary(token)])
      .then(([sales, inventory]) => {
        if (active) {
          setSummary(sales);
          setStock(inventory);
        }
      })
      .catch((err) => {
        if (active) setNotice({ text: err.message, error: true });
      });
    return () => {
      active = false;
    };
  }, [token, refresh]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    setLoading(true);
    const query = new URLSearchParams({
      limit: '20',
      offset: String(offset),
      q,
      ...(tab === 'orders' && status ? { status } : {}),
    }).toString();
    const work =
      tab === 'products'
        ? api.products(query).then((result) => {
            if (active) {
              setProducts(result.products);
              setProductTotal(result.total ?? result.products.length);
            }
          })
        : api.adminOrders(token, query).then((result) => {
            if (active) setOrders(result);
          });
    work
      .catch((err) => {
        if (active) setNotice({ text: err.message, error: true });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, tab, offset, q, status, refresh]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!token || lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const body = { name: form.name.trim(), price: Number(form.price), stock: Number(form.stock) };
      if (editing) await api.updateProduct(editing, { ...body, expectedRevision: revision }, token);
      else await api.createProduct(body, token);
      setNotice({
        text: editing ? 'Produk berhasil diperbarui' : 'Produk baru berhasil ditambahkan',
        error: false,
      });
      setShowForm(false);
      setEditing(null);
      setForm(blank);
      setRefresh((value) => value + 1);
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Gagal menyimpan produk',
        error: true,
      });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function remove() {
    if (!token || !deleting || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await api.deleteProduct(deleting.id, token);
      setNotice({
        text: 'Produk dihapus. Rincian pesanan terdahulu tetap tersimpan.',
        error: false,
      });
      setDeleting(null);
      if (products.length === 1 && offset) setOffset(Math.max(0, offset - 20));
      setRefresh((value) => value + 1);
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Gagal menghapus produk',
        error: true,
      });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function switchTab(next: string) {
    setParams(next === 'orders' ? { tab: next } : {});
    setOffset(0);
    setQ('');
    setDraft('');
    setStatus('');
    setShowForm(false);
    setDeleting(null);
    setNotice(null);
  }
  return (
    <ShopLayout>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PUSAT OPERASIONAL</p>
          <h1>Dashboard admin</h1>
          <p className="text-muted mt-2">
            Kelola katalog, pantau stok, dan proses pesanan pelanggan.
          </p>
        </div>
        <button className="button-secondary" onClick={() => setRefresh((value) => value + 1)}>
          Muat ulang data
        </button>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          ['Total produk', stock?.totalProducts],
          ['Stok menipis / habis', stock ? `${stock.lowStock} / ${stock.outOfStock}` : undefined],
          ['Pesanan terkonfirmasi', summary?.confirmedOrders],
          ['Nilai pesanan terkonfirmasi', summary ? rupiah(summary.confirmedValue) : undefined],
        ].map(([label, value]) => (
          <div className="panel" key={String(label)}>
            <p className="text-xs text-muted mb-3">{label}</p>
            <p className="text-2xl font-semibold text-primary">{value ?? '-'}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted mb-6">
        Nilai pesanan menunjukkan alokasi stok, bukan pembayaran yang diterima. Menunggu konfirmasi:{' '}
        {summary?.pendingOrders ?? '-'}; sedang diproses: {summary?.processingOrders ?? '-'};
        dibatalkan: {summary?.cancelledOrders ?? '-'}.
      </p>
      {notice && <Notice error={notice.error}>{notice.text}</Notice>}
      <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
        <div className="flex rounded-xl bg-slate-200 p-1" role="tablist" aria-label="Kelola data">
          <button
            role="tab"
            aria-selected={tab === 'products'}
            className={`rounded-lg px-5 py-2 text-sm font-medium ${tab === 'products' ? 'bg-white text-primary shadow-sm' : 'text-muted'}`}
            onClick={() => switchTab('products')}
          >
            Produk & stok
          </button>
          <button
            role="tab"
            aria-selected={tab === 'orders'}
            className={`rounded-lg px-5 py-2 text-sm font-medium ${tab === 'orders' ? 'bg-white text-primary shadow-sm' : 'text-muted'}`}
            onClick={() => switchTab('orders')}
          >
            Pesanan
          </button>
        </div>
        {tab === 'products' && (
          <button
            className="button-primary"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setForm(blank);
              setShowForm(true);
            }}
          >
            Tambah produk
          </button>
        )}
      </div>
      {showForm && tab === 'products' && (
        <form onSubmit={save} className="panel mb-6">
          <h2 className="text-lg font-semibold text-primary mb-5">
            {editing ? 'Edit produk' : 'Produk baru'}
          </h2>
          <div className="grid sm:grid-cols-3 gap-4">
            <label className="text-sm">
              Nama produk
              <input
                className="field mt-2"
                required
                maxLength={200}
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                disabled={busy}
              />
            </label>
            <label className="text-sm">
              Harga (Rp)
              <input
                className="field mt-2"
                type="number"
                required
                min="1"
                max="1000000000"
                step="1"
                value={form.price}
                onChange={(event) =>
                  setForm((current) => ({ ...current, price: event.target.value }))
                }
                disabled={busy}
              />
            </label>
            <label className="text-sm">
              Stok tersedia
              <input
                className="field mt-2"
                type="number"
                required
                min="0"
                max="1000000"
                step="1"
                value={form.stock}
                onChange={(event) =>
                  setForm((current) => ({ ...current, stock: event.target.value }))
                }
                disabled={busy}
              />
            </label>
          </div>
          {editing && (
            <p className="text-xs text-muted mt-3">
              Stok ini adalah jumlah yang masih tersedia, di luar stok yang telah dialokasikan ke
              pesanan.
            </p>
          )}
          <div className="flex gap-3 mt-5">
            <button className="button-primary" disabled={busy}>
              {busy ? 'Menyimpan...' : 'Simpan produk'}
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => setShowForm(false)}
            >
              Batal
            </button>
          </div>
        </form>
      )}
      {deleting && (
        <div className="panel border-red-200 mb-6" role="alert">
          <p>
            Hapus produk <strong>{deleting.name}</strong> dari katalog? Data pesanan terdahulu tetap
            tersedia.
          </p>
          <div className="flex gap-3 mt-4">
            <button
              className="button-primary bg-danger hover:bg-red-700"
              disabled={busy}
              onClick={() => void remove()}
            >
              Ya, hapus produk
            </button>
            <button className="button-secondary" disabled={busy} onClick={() => setDeleting(null)}>
              Batal
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-3 mb-5">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQ(draft.trim());
            setOffset(0);
          }}
        >
          <input
            className="field"
            aria-label={tab === 'products' ? 'Cari produk admin' : 'Cari pesanan admin'}
            placeholder={tab === 'products' ? 'Nama produk...' : 'ID pesanan / penerima...'}
            maxLength={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="button-secondary">Cari</button>
        </form>
        {tab === 'orders' && (
          <select
            aria-label="Filter status admin"
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
        )}
      </div>
      <section className="panel overflow-x-auto">
        {loading ? (
          <p role="status">Memuat data...</p>
        ) : tab === 'products' ? (
          <table className="w-full text-sm">
            <caption className="sr-only">Daftar produk dan stok</caption>
            <thead>
              <tr className="text-left text-muted border-b">
                <th className="py-3 pr-4">Produk</th>
                <th className="pr-4">Harga</th>
                <th className="pr-4">Stok</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id} className="border-b last:border-0">
                  <td className="py-4 pr-4 font-medium text-primary">{product.name}</td>
                  <td className="pr-4 whitespace-nowrap">{rupiah(product.price)}</td>
                  <td className={`pr-4 ${product.stock <= 5 ? 'text-danger font-semibold' : ''}`}>
                    {product.stock}
                  </td>
                  <td>
                    <div className="flex gap-4">
                      <button
                        className="text-secondary underline"
                        disabled={busy}
                        onClick={() => {
                          setEditing(product.id);
                          setRevision(product.revision ?? 0);
                          setForm({
                            name: product.name,
                            price: String(product.price),
                            stock: String(product.stock),
                          });
                          setShowForm(true);
                        }}
                      >
                        Edit<span className="sr-only"> {product.name}</span>
                      </button>
                      <button
                        className="text-danger underline"
                        disabled={busy}
                        onClick={() => setDeleting(product)}
                      >
                        Hapus<span className="sr-only"> {product.name}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Daftar pesanan pelanggan</caption>
            <thead>
              <tr className="border-b text-left text-muted">
                <th className="py-3 pr-4">Pesanan / penerima</th>
                <th className="pr-4">Tanggal</th>
                <th className="pr-4">Total produk</th>
                <th className="pr-4">Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {orders?.orders.map((order) => (
                <tr className="border-b last:border-0" key={order.id}>
                  <td className="py-4 pr-4">
                    <strong className="text-primary">#{order.id.slice(0, 8).toUpperCase()}</strong>
                    <span className="block text-muted text-xs mt-1">
                      {order.shippingAddress?.recipient ?? 'Tanpa alamat'}
                    </span>
                  </td>
                  <td className="pr-4 whitespace-nowrap text-xs">{dateTime(order.createdAt)}</td>
                  <td className="pr-4 whitespace-nowrap">{rupiah(order.total)}</td>
                  <td className="pr-4">
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge status={order.status} />
                      {order.status === 'CONFIRMED' && (
                        <StatusBadge status={order.fulfillmentStatus} />
                      )}
                    </div>
                  </td>
                  <td>
                    <Link className="text-secondary underline" to={`/admin/orders/${order.id}`}>
                      Buka
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && (tab === 'products' ? products.length === 0 : !orders?.orders.length) && (
          <p className="text-muted text-sm py-6 text-center">Tidak ada data yang sesuai.</p>
        )}
      </section>
      <Pagination
        offset={offset}
        total={tab === 'products' ? productTotal : (orders?.total ?? 0)}
        onChange={setOffset}
      />
    </ShopLayout>
  );
}
