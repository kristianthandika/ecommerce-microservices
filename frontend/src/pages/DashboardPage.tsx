import { useEffect, useState } from 'react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { HealthWidget } from '../components/HealthWidget';
import { api, ApiError, type Product } from '../api/client';
import { useAuth } from '../context/AuthContext';

const rupiah = (n: number) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n);

export function DashboardPage() {
  const { token } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .products()
      .then((r) => setProducts(r.products))
      .catch((e) => setNotice({ kind: 'err', text: e instanceof ApiError ? e.message : 'Gagal memuat produk' }))
      .finally(() => setLoading(false));
  }, []);

  async function order(product: Product) {
    setNotice(null);
    try {
      await api.createOrder([{ productId: product.id, quantity: 1 }], token!);
      setNotice({ kind: 'ok', text: `Order "${product.name}" berhasil dibuat` });
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof ApiError ? e.message : 'Gagal membuat order' });
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-8 grid gap-8 lg:grid-cols-[1fr_320px]">
        <section>
          <h1 className="text-2xl font-semibold text-primary mb-1">Katalog Produk</h1>
          <p className="text-sm text-muted mb-6">
            Data melewati gateway → product-service. Order melewati order-service (resilient).
          </p>

          {notice && (
            <p
              role="status"
              className={`mb-4 text-sm rounded-lg px-3 py-2 ${
                notice.kind === 'ok' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
              }`}
            >
              {notice.text}
            </p>
          )}

          {loading ? (
            <p className="text-muted">Memuat…</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {products.map((p) => (
                <article
                  key={p.id}
                  className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm flex flex-col"
                >
                  <h3 className="font-semibold text-ink">{p.name}</h3>
                  <p className="text-secondary font-medium mt-1">{rupiah(p.price)}</p>
                  <p className="text-xs text-muted mt-1">Stok: {p.stock}</p>
                  <button
                    type="button"
                    onClick={() => order(p)}
                    className="mt-4 rounded-lg bg-accent hover:bg-secondary text-white text-sm font-medium py-2 transition-colors"
                  >
                    Buat Order (1)
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside>
          <HealthWidget />
        </aside>
      </main>
      <Footer />
    </div>
  );
}
