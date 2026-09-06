import footer from '../assets/brand/footer.png';

export function Footer() {
  return (
    <footer className="mt-auto border-t border-gray-200 bg-white">
      <div className="max-w-6xl mx-auto px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
        <img src={footer} alt="Inixindo Bandung" className="h-8 w-auto" />
        <p className="text-xs text-muted">
          © {new Date().getFullYear()} Inixindo Bandung — Pelatihan Microservice Node.js & React
        </p>
      </div>
    </footer>
  );
}
