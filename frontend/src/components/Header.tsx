import { useEffect, useId, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import logo from '../assets/brand/logo.png';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';

type IconName = 'catalog' | 'cart' | 'orders' | 'admin';
const paths: Record<IconName, string> = {
  catalog: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  cart: 'M3 3h2l2.5 12h11l2-8H6 M9 20h.01 M18 20h.01',
  orders: 'M7 3h10v18l-2-1.5-3 1.5-3-1.5L7 21z M10 8h4 M10 12h4 M10 16h2',
  admin: 'M4 20V10 M12 20V4 M20 20v-7 M1 20h22',
};
function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Header() {
  const { user, logout } = useAuth();
  const { cart } = useCart();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const menuId = useId();
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  const quantity = cart?.quantity ?? 0;
  const links: { to: string; label: string; icon: IconName; active?: boolean }[] = [
    { to: '/dashboard', label: 'Katalog', icon: 'catalog' },
    { to: '/cart', label: 'Keranjang', icon: 'cart', active: pathname === '/checkout' },
    { to: '/orders', label: 'Pesanan saya', icon: 'orders' },
    ...(user?.role === 'admin'
      ? [{ to: '/admin', label: 'Dashboard admin', icon: 'admin' as const }]
      : []),
  ];
  function navigation(mobile = false) {
    return links.map((link) => (
      <NavLink
        key={link.to}
        to={link.to}
        onClick={() => setMenuOpen(false)}
        className={({ isActive }) =>
          `flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${mobile ? 'w-full' : 'whitespace-nowrap'} ${isActive || link.active ? 'bg-blue-50 text-primary' : 'text-slate-600 hover:bg-slate-50 hover:text-primary'}`
        }
      >
        <NavIcon name={link.icon} />
        <span>{link.label}</span>
        {link.icon === 'cart' && (
          <span
            aria-label={`${quantity} barang`}
            className="ml-auto min-w-6 rounded-full bg-primary px-1.5 py-0.5 text-center text-[11px] font-semibold text-white tabular-nums"
          >
            {quantity > 99 ? '99+' : quantity}
          </span>
        )}
      </NavLink>
    ));
  }
  return (
    <header className="relative z-20 shrink-0 border-b border-slate-200 bg-white shadow-sm">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-white"
      >
        Langsung ke konten
      </a>
      <div className="h-1 bg-gradient-to-r from-primary via-secondary to-accent" />
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:gap-6 sm:py-4">
        <Link
          to="/dashboard"
          aria-label="Inixindo Bandung Store - beranda"
          className="flex shrink-0 items-center gap-2.5 rounded-lg sm:gap-3"
        >
          <img
            src={logo}
            alt=""
            className="h-12 w-10 object-contain sm:h-14 sm:w-12"
            width="48"
            height="56"
          />
          <span>
            <span className="block text-base font-bold tracking-wide text-primary sm:text-lg">
              INIXINDO
            </span>
            <span className="mt-0.5 flex items-center gap-2 text-[11px] font-medium text-slate-500 sm:text-xs">
              <span>Bandung</span>
              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-accent" />
              <span className="text-secondary">Store</span>
            </span>
          </span>
        </Link>
        {user && (
          <nav aria-label="Navigasi utama" className="hidden items-center gap-1 xl:flex">
            {navigation()}
          </nav>
        )}
        {user ? (
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="hidden min-w-0 items-center gap-2.5 border-l border-slate-200 pl-4 sm:flex">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold uppercase text-primary"
              >
                {user.email.slice(0, 1)}
              </span>
              <div className="min-w-0">
                <p
                  className="max-w-28 truncate text-xs font-medium text-slate-700 xl:max-w-36"
                  title={user.email}
                >
                  {user.email}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {user.role === 'admin' ? 'Administrator' : 'Pelanggan'}
                </p>
              </div>
            </div>
            <button
              className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-red-50 hover:text-danger"
              type="button"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                setLogoutError('');
                try {
                  await logout();
                } catch {
                  setLogoutError(
                    'Sesi belum berhasil ditutup di server. Periksa koneksi lalu coba Keluar lagi.',
                  );
                } finally {
                  setSigningOut(false);
                }
              }}
              aria-label="Keluar"
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 5H5v14h4 M14 8l4 4-4 4 M9 12h12" />
              </svg>
              <span className="hidden xl:inline">{signingOut ? 'Menutup sesi...' : 'Keluar'}</span>
            </button>
            <button
              type="button"
              className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-primary hover:bg-slate-50 xl:hidden"
              aria-label={menuOpen ? 'Tutup menu navigasi' : 'Buka menu navigasi'}
              id={`${menuId}-toggle`}
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <svg
                aria-hidden="true"
                width="21"
                height="21"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d={menuOpen ? 'M6 6l12 12 M6 18L18 6' : 'M4 6h16 M4 12h16 M4 18h16'} />
              </svg>
              {quantity > 0 && !menuOpen && (
                <span
                  aria-hidden="true"
                  className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-accent"
                />
              )}
            </button>
          </div>
        ) : (
          <Link to="/login" className="button-primary">
            Masuk
          </Link>
        )}
      </div>
      {logoutError && (
        <p role="alert" className="mx-auto max-w-6xl px-4 pb-3 text-sm text-danger">
          {logoutError}
        </p>
      )}
      {user && menuOpen && (
        <nav
          id={menuId}
          aria-label="Navigasi seluler"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setMenuOpen(false);
              document.getElementById(`${menuId}-toggle`)?.focus();
            }
          }}
          className="border-t border-slate-100 bg-white px-4 pb-4 pt-3 xl:hidden"
        >
          <div className="mx-auto max-w-6xl">
            <p className="mb-3 truncate px-3 text-xs text-slate-500">{user.email}</p>
            <div className="space-y-1">{navigation(true)}</div>
          </div>
        </nav>
      )}
    </header>
  );
}
