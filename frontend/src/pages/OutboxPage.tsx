import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type OutboxMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { ShopLayout, Notice, dateTime } from '../components/ShopLayout';

/**
 * Training mailbox: mail the system "sent" while MAIL_TRANSPORT=outbox. It lets a
 * class verify accounts without a real mail server. With a real transport the API
 * route does not exist and this page says so.
 */
export function OutboxPage() {
  const { token } = useAuth();
  const [messages, setMessages] = useState<OutboxMessage[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    let active = true;
    setMessages(null);
    setError('');
    api
      .outbox(token)
      .then((result) => {
        if (active) {
          setMessages(result.messages);
          setError('');
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'Kotak surat pelatihan tidak aktif: email dikirim lewat layanan email sungguhan.'
            : err instanceof Error
              ? err.message
              : 'Gagal memuat kotak surat',
        );
      });
    return () => {
      active = false;
    };
  }, [token, reload]);

  return (
    <ShopLayout>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ADMIN · PELATIHAN</p>
          <h1>Kotak surat pelatihan</h1>
          <p className="text-muted mt-2">
            Email pelatihan dalam 24 jam terakhir. Kotak surat ini hanya tersedia saat pengiriman
            email menggunakan mode pelatihan.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="button-secondary" onClick={() => setReload((value) => value + 1)}>
            Muat ulang
          </button>
          <Link className="button-secondary" to="/admin">
            Kembali ke admin
          </Link>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      {!error && !messages && <p role="status">Memuat email...</p>}
      {messages?.length === 0 && <p className="panel text-muted">Belum ada email.</p>}
      <ul className="space-y-4">
        {messages?.map((message) => (
          <li key={message.id} className="panel">
            <p className="text-sm text-muted">
              {dateTime(message.createdAt)} · kepada{' '}
              <strong className="break-all">{message.to}</strong>
            </p>
            <h2 className="font-semibold text-primary mt-1">{message.subject}</h2>
            <p className="text-sm whitespace-pre-line break-words mt-3">{message.text}</p>
            {message.link && /^https?:\/\//i.test(message.link) && (
              <a className="button-primary inline-flex mt-4" href={message.link}>
                Buka tautan verifikasi
              </a>
            )}
          </li>
        ))}
      </ul>
    </ShopLayout>
  );
}
