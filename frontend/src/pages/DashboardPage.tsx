import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Product } from '../api/client';
import { useCart } from '../context/CartContext';
import { ShopLayout, Notice, Pagination, rupiah } from '../components/ShopLayout';
import { HealthWidget } from '../components/HealthWidget';

export function DashboardPage() {
  const { cart, add, busy } = useCart();
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const query =
      q || offset
        ? new URLSearchParams({ q, offset: String(offset), limit: '20' }).toString()
        : 'limit=20';
    api
      .products(query)
      .then((result) => {
        if (active) {
          setProducts(result.products);
          setTotal(result.total ?? result.products.length);
        }
      })
      .catch((err) => {
        if (active) setNotice({ text: err.message, error: true });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [q, offset]);
  async function addProduct(product: Product) {
    setNotice(null);
    try {
      await add(product.id);
      setNotice({ text: `${product.name} ditambahkan ke keranjang`, error: false });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Gagal menambahkan produk',
        error: true,
      });
    }
  }
  return (
    <ShopLayout>
      <section className="rounded-2xl bg-primary text-white p-6 sm:p-9 mb-8 flex flex-wrap justify-between items-center gap-5">
        <div>
          <p className="text-accent text-xs font-semibold tracking-widest mb-3">INIXINDO STORE</p>
          <h1 className="text-3xl sm:text-4xl font-semibold leading-tight">
            Belanja lebih terencana.
          </h1>
          <p className="text-blue-100 mt-3 text-sm max-w-xl">
            Pilih produk, atur keranjang, dan pantau pesanan Anda dalam satu tempat.
          </p>
        </div>
        <Link
          className="rounded-xl bg-white text-primary font-semibold px-5 py-3 text-sm"
          to="/cart"
        >
          Lihat keranjang ({cart?.quantity ?? 0})
        </Link>
      </section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TEMUKAN PILIHAN ANDA</p>
          <h2 className="text-2xl font-semibold text-primary">Katalog Produk</h2>
        </div>
        <form
          className="flex gap-2 w-full sm:w-auto"
          onSubmit={(event) => {
            event.preventDefault();
            setQ(draft.trim());
            setOffset(0);
          }}
        >
          <input
            className="field"
            aria-label="Cari produk"
            placeholder="Cari nama produk..."
            maxLength={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="button-secondary">Cari</button>
        </form>
      </div>
      {notice && (
        <Notice error={notice.error}>
          {notice.text}{' '}
          {!notice.error && (
            <Link className="underline font-semibold ml-2" to="/cart">
              Buka keranjang
            </Link>
          )}
        </Notice>
      )}
      {loading ? (
        <p role="status">Memuat produk...</p>
      ) : !products.length ? (
        <div className="panel text-center py-12">
          <p className="font-semibold text-primary">Produk belum ditemukan</p>
          <p className="text-muted text-sm mt-2">Coba kata pencarian lain.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {products.map((product, index) => (
            <article key={product.id} className="panel flex flex-col">
              <div className="rounded-xl h-24 bg-gradient-to-br from-blue-50 to-slate-100 flex items-center justify-between p-5 mb-5">
                <span className="text-primary/20 text-4xl font-semibold" aria-hidden="true">
                  {String(offset + index + 1).padStart(2, '0')}
                </span>
                <span
                  className={`text-xs rounded-full px-3 py-1 ${product.stock ? 'bg-white text-success' : 'bg-red-50 text-danger'}`}
                >
                  {product.stock ? 'Tersedia' : 'Stok habis'}
                </span>
              </div>
              <h3 className="text-lg font-semibold text-primary">{product.name}</h3>
              <p className="font-semibold text-secondary text-xl mt-3">{rupiah(product.price)}</p>
              <p className="text-sm text-muted mt-2 mb-5">Stok: {product.stock}</p>
              <button
                className="button-primary mt-auto"
                disabled={
                  busy ||
                  !cart ||
                  product.stock < 1 ||
                  (cart.items.find((item) => item.productId === product.id)?.quantity ?? 0) >=
                    Math.min(product.stock, 1000)
                }
                onClick={() => void addProduct(product)}
              >
                Tambah ke keranjang
              </button>
            </article>
          ))}
        </div>
      )}
      {!loading && <Pagination offset={offset} total={total} onChange={setOffset} />}
      <details className="mt-10">
        <summary className="text-sm text-muted cursor-pointer">Status layanan</summary>
        <div className="mt-4 max-w-md">
          <HealthWidget />
        </div>
      </details>
    </ShopLayout>
  );
}
