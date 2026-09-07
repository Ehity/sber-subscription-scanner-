export default function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-[#0B0F1A]/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="sber-gradient flex h-11 w-11 items-center justify-center rounded-2xl text-xl font-black text-white shadow-lg shadow-emerald-500/20">
            ₽
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              Сбер<span className="text-emerald-400">.</span>Сканер Подписок
            </h1>
            <p className="text-xs text-slate-500">
              Найдём забытые подписки и вернём ваши деньги
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}
