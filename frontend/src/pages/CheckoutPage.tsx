import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type ShippingAddress } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { ShopLayout, Notice, rupiah } from '../components/ShopLayout';

const emptyAddress: ShippingAddress = {
  recipient: '',
  phone: '',
  street: '',
  city: '',
  province: '',
  postalCode: '',
  notes: '',
};
export function CheckoutPage() {
  const { token, user } = useAuth();
  // The server refuses orders from unverified accounts; do not offer a button that fails.
  const unverified = user?.emailVerified === false;
  const { cart, reload } = useCart();
  useEffect(() => {
    void reload().catch(() => {});
  }, [reload]);
  const navigate = useNavigate();
  const [address, setAddress] = useState(emptyAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Network failures and 5xx leave the outcome unknown; a 4xx is a definite answer.
  const [ambiguous, setAmbiguous] = useState(false);
  const lock = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || !cart?.canCheckout || unverified || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const fingerprint = JSON.stringify([cart.version, address]);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const { order } = await api.checkout(cart.version, address, attempt.current.key, token);
      await reload().catch(() => {});
      void navigate(`/orders/${order.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout gagal');
      setAmbiguous(!(err instanceof ApiError) || err.status === 0 || err.status >= 500);
      if (err instanceof ApiError && [400, 409].includes(err.status))
        await reload().catch(() => {});
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function field(
    name: keyof ShippingAddress,
    label: string,
    options: {
      type?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      autoComplete?: string;
    } = {},
  ) {
    return (
      <label className="block text-sm font-medium" key={name}>
        {label}
        <input
          className="field mt-2"
          name={name}
          value={address[name]}
          onChange={(event) =>
            setAddress((current) => ({ ...current, [name]: event.target.value }))
          }
          required
          disabled={busy}
          {...options}
        />
      </label>
    );
  }
  return (
    <ShopLayout>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LANGKAH TERAKHIR</p>
          <h1>Checkout</h1>
          <p className="text-muted mt-2">Periksa alamat dan pesanan sebelum mengalokasikan stok.</p>
        </div>
        <Link className="button-secondary" to="/cart">
          Kembali ke keranjang
        </Link>
      </div>
      {error && (
        <Notice error>
          {error}{' '}
          {ambiguous ? 'Jika hasil belum pasti, gunakan tombol yang sama atau periksa ' : 'Lihat '}
          <Link to="/orders" className="underline font-semibold">
            riwayat pesanan
          </Link>
          .
        </Notice>
      )}
      {!cart ? (
        <p role="status">Memuat keranjang...</p>
      ) : !cart.items.length ? (
        <div className="panel">
          <p>Keranjang kosong. Pilih produk sebelum checkout.</p>
          <Link className="button-primary inline-flex mt-4" to="/dashboard">
            Buka katalog
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="grid lg:grid-cols-[1fr_360px] gap-6">
          <section className="panel">
            <h2 className="text-xl font-semibold text-primary mb-6">Alamat penerima</h2>
            <div className="grid sm:grid-cols-2 gap-5">
              {field('recipient', 'Nama penerima', {
                minLength: 2,
                maxLength: 100,
                autoComplete: 'shipping name',
              })}
              {field('phone', 'Nomor telepon', {
                type: 'tel',
                minLength: 8,
                maxLength: 24,
                autoComplete: 'shipping tel',
              })}
              <div className="sm:col-span-2">
                {field('street', 'Alamat lengkap', {
                  minLength: 5,
                  maxLength: 300,
                  autoComplete: 'shipping street-address',
                })}
              </div>
              {field('city', 'Kota / kabupaten', {
                minLength: 2,
                maxLength: 100,
                autoComplete: 'shipping address-level2',
              })}
              {field('province', 'Provinsi', {
                minLength: 2,
                maxLength: 100,
                autoComplete: 'shipping address-level1',
              })}
              {field('postalCode', 'Kode pos', {
                pattern: '[0-9]{5}',
                maxLength: 5,
                autoComplete: 'shipping postal-code',
              })}
              <label className="sm:col-span-2 text-sm font-medium">
                Catatan (opsional)
                <textarea
                  className="field mt-2"
                  rows={3}
                  maxLength={500}
                  disabled={busy}
                  value={address.notes}
                  onChange={(event) =>
                    setAddress((current) => ({ ...current, notes: event.target.value }))
                  }
                />
              </label>
            </div>
          </section>
          <aside className="panel h-fit">
            <h2 className="text-lg font-semibold text-primary">Ringkasan pesanan</h2>
            <ul className="divide-y my-4">
              {cart.items.map((item) => (
                <li key={item.productId} className="py-3 text-sm flex justify-between gap-3">
                  <span>
                    {item.name}
                    <span className="block text-muted mt-1">
                      {item.quantity} x {rupiah(item.unitPrice)}
                    </span>
                    {!item.available && (
                      <span className="text-danger block">Stok tidak mencukupi</span>
                    )}
                  </span>
                  <strong>{rupiah(item.subtotal)}</strong>
                </li>
              ))}
            </ul>
            <div className="border-t pt-4 flex justify-between text-lg font-semibold text-primary">
              <span>Total produk</span>
              <span>{rupiah(cart.total)}</span>
            </div>
            <p className="text-xs text-muted my-4 leading-relaxed">
              Harga akhir mengikuti harga terbaru saat konfirmasi. Pembayaran online dan perhitungan
              ongkir belum tersedia. Tidak ada penagihan otomatis.
            </p>
            <button
              className="button-primary w-full"
              disabled={busy || !cart.canCheckout || unverified}
            >
              {busy ? 'Mengonfirmasi...' : 'Konfirmasi pesanan'}
            </button>
          </aside>
        </form>
      )}
    </ShopLayout>
  );
}
