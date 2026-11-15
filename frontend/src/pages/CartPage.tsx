import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { ShopLayout, Notice, rupiah } from '../components/ShopLayout';

export function CartPage() {
  const { cart, busy, error, reload, setQuantity, remove } = useCart();
  useEffect(() => {
    void reload().catch(() => {});
  }, [reload]);
  const [notice, setNotice] = useState('');
  async function act(work: () => Promise<unknown>) {
    setNotice('');
    try {
      await work();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Gagal memperbarui keranjang');
    }
  }
  return (
    <ShopLayout>
      <div className="page-heading">
        <div>
          <p className="eyebrow">BELANJA ANDA</p>
          <h1>Keranjang belanja</h1>
          <p className="text-muted mt-2">Harga dan ketersediaan diperiksa kembali saat checkout.</p>
        </div>
        <Link className="button-secondary" to="/dashboard">
          Lanjut belanja
        </Link>
      </div>
      {(notice || error) && (
        <Notice error>
          {notice || error}{' '}
          <button className="underline ml-2" onClick={() => void act(reload)}>
            Muat ulang
          </button>
        </Notice>
      )}
      {!cart ? (
        <p role="status">Memuat keranjang...</p>
      ) : !cart.items.length ? (
        <div className="panel text-center py-16">
          <h2 className="text-xl font-semibold text-primary">Keranjang masih kosong</h2>
          <p className="text-muted my-3">Pilih produk favorit Anda dari katalog.</p>
          <Link to="/dashboard" className="button-primary inline-flex">
            Jelajahi produk
          </Link>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="space-y-4">
            {cart.items.map((item) => (
              <article key={`${cart.version}:${item.productId}`} className="panel">
                <div className="flex justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-primary">{item.name}</h2>
                    <p className="text-sm text-muted mt-1">{rupiah(item.unitPrice)} / unit</p>
                    {!item.available && (
                      <p className="text-danger text-sm mt-2">
                        Stok tersedia {item.stock}. Ubah jumlah atau hapus produk ini.
                      </p>
                    )}
                  </div>
                  <strong>{rupiah(item.subtotal)}</strong>
                </div>
                <div className="flex items-end justify-between mt-5 gap-3">
                  <form
                    className="flex items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = new FormData(event.currentTarget).get('quantity');
                      void act(() => setQuantity(item.productId, Number(value)));
                    }}
                  >
                    <label className="text-sm">
                      Jumlah
                      <input
                        className="field w-24 mt-1"
                        name="quantity"
                        aria-label={`Jumlah ${item.name}`}
                        type="number"
                        min="1"
                        max="1000"
                        required
                        defaultValue={item.quantity}
                        disabled={busy}
                      />
                    </label>
                    <button className="button-secondary" disabled={busy}>
                      Perbarui
                    </button>
                  </form>
                  <button
                    className="text-sm text-danger underline"
                    disabled={busy}
                    onClick={() => void act(() => remove(item.productId))}
                    aria-label={`Hapus ${item.name}`}
                  >
                    Hapus
                  </button>
                </div>
              </article>
            ))}
          </div>
          <aside className="panel h-fit lg:sticky lg:top-6">
            <h2 className="font-semibold text-lg text-primary">Ringkasan belanja</h2>
            <div className="flex justify-between text-sm my-5">
              <span>{cart.quantity} barang</span>
              <span>{rupiah(cart.total)}</span>
            </div>
            <div className="border-t pt-4 flex justify-between font-semibold mb-5">
              <span>Total produk</span>
              <span>{rupiah(cart.total)}</span>
            </div>
            {cart.canCheckout ? (
              <Link
                to="/checkout"
                className={`button-primary flex justify-center ${busy ? 'pointer-events-none opacity-50' : ''}`}
              >
                Lanjut ke checkout
              </Link>
            ) : (
              <button className="button-primary w-full" disabled>
                Periksa stok dahulu
              </button>
            )}
            <p className="text-xs text-muted mt-4">
              Belum ada pembayaran online. Stok dialokasikan setelah pesanan terkonfirmasi.
            </p>
          </aside>
        </div>
      )}
    </ShopLayout>
  );
}
