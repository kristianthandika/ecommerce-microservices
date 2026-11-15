import { Link } from 'react-router-dom';
import logo from '../assets/brand/logo.png';

export function Footer() {
  return (
    <footer className="mt-auto shrink-0 border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-6xl gap-7 px-4 py-8 sm:grid-cols-[1fr_auto] sm:items-center sm:py-10">
        <div className="flex items-center gap-3.5">
          <img
            src={logo}
            alt=""
            className="h-14 w-12 shrink-0 object-contain"
            width="48"
            height="56"
            loading="lazy"
          />
          <div>
            <p className="font-semibold text-primary">
              Inixindo Bandung
              <span className="mx-2 text-slate-300" aria-hidden="true">
                /
              </span>
              <span className="font-normal text-secondary">Store</span>
            </p>
            <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-slate-500">
              Continuous learning, keep up to date.
            </p>
          </div>
        </div>
        <nav
          aria-label="Navigasi footer"
          className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm font-medium text-slate-600"
        >
          <Link to="/dashboard" className="rounded hover:text-primary">
            Katalog
          </Link>
          <Link to="/cart" className="rounded hover:text-primary">
            Keranjang
          </Link>
          <Link to="/orders" className="rounded hover:text-primary">
            Pesanan saya
          </Link>
        </nav>
      </div>
      <div className="border-t border-slate-100 bg-slate-50/70">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-4 text-[11px] leading-relaxed text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Inixindo Bandung. Seluruh hak cipta dilindungi.</p>
          <p>Platform pembelajaran e-commerce</p>
        </div>
      </div>
    </footer>
  );
}
