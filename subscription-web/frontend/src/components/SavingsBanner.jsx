import { PiggyBank, CalendarClock, TrendingDown } from "lucide-react";

const fmt = (n) => Math.round(n).toLocaleString("ru-RU");

export default function SavingsBanner({ totalYearly, totalMonthly, cancelledCount }) {
  const hasSubscriptions = totalYearly > 0 || totalMonthly > 0;

  // Адаптивный заголовок и подпись в зависимости от состояния
  const title = cancelledCount > 0
    ? "Вы сэкономите"
    : hasSubscriptions
      ? "Потенциальная экономия"
      : "Подписок не найдено";

  const subtitle = cancelledCount > 0
    ? `Экономия при отказе от ${cancelledCount} подписк(и/ок) · ${fmt(totalYearly / 12)} ₽/мес возвращается в бюджет`
    : hasSubscriptions
      ? `Это ${fmt(totalMonthly)} ₽ каждый месяц уходит на подписки`
      : "Загрузите выписку с подписками, чтобы увидеть потенциальную экономию";

  return (
    <section className="sber-gradient relative overflow-hidden rounded-3xl p-8 shadow-2xl shadow-emerald-500/10">
      <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
      <div className="absolute -bottom-28 right-40 h-64 w-64 rounded-full bg-sky-400/20 blur-3xl" />

      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white/80">
            <PiggyBank size={18} />
            {title}
          </div>
          <div className="flex items-baseline gap-2">
            {hasSubscriptions ? (
              <>
                <span className="text-6xl font-black tracking-tight text-white drop-shadow">
                  {fmt(totalYearly)} ₽
                </span>
                <span className="text-xl font-semibold text-white/80">/ год</span>
              </>
            ) : (
              <span className="text-3xl font-bold text-white/90">—</span>
            )}
          </div>
          <p className="mt-2 text-sm text-white/80">{subtitle}</p>
        </div>

        {hasSubscriptions && (
          <div className="flex gap-3">
            <div className="rounded-2xl bg-black/20 px-5 py-4 backdrop-blur">
              <div className="flex items-center gap-1.5 text-xs text-white/70">
                <CalendarClock size={14} /> В месяц
              </div>
              <div className="mt-1 text-2xl font-bold text-white">{fmt(totalMonthly)} ₽</div>
            </div>
            <div className="rounded-2xl bg-black/20 px-5 py-4 backdrop-blur">
              <div className="flex items-center gap-1.5 text-xs text-white/70">
                <TrendingDown size={14} /> За 5 лет
              </div>
              <div className="mt-1 text-2xl font-bold text-white">{fmt(totalYearly * 5)} ₽</div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
