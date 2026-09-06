import { Link } from 'react-router-dom';
import logo from '../assets/brand/logo.png';
import { useAuth } from '../context/AuthContext';

export function Header() {
  const { user, logout } = useAuth();
  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3">
          <img src={logo} alt="Inixindo Bandung" className="h-9 w-auto" />
          <span className="hidden sm:inline text-primary font-semibold">
            E-Commerce Microservices
          </span>
        </Link>
        {user && (
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted">
              {user.email}{' '}
              <span className="ml-1 inline-block rounded-full bg-subtle px-2 py-0.5 text-xs text-secondary">
                {user.role}
              </span>
            </span>
            <button
              onClick={logout}
              className="text-sm font-medium text-danger hover:underline"
              type="button"
            >
              Keluar
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
