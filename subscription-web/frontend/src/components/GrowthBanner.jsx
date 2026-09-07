import { TrendingDown, TrendingUp } from "lucide-react";

const fmt = (n) => Math.round(n).toLocaleString("ru-RU");

/**
 * «Рост стоимости подписок»: сравнивает текущие месячные расходы с теми,
 * что были до подтверждённых повышений цены. Например: «Яндекс Плюс стоил
 * 99 ₽, теперь 299 ₽» → «Расходы на подписки выросли на N% за 6 месяцев».
 */
export default function GrowthBanner({ subscriptions }) {
  let now = 0;
  let before = 0;
  let worst = null;
  for (const sub of subscriptions) {
    const current = Math.abs(sub.monthly_cost);
    now += current;
    const pc = sub.price_change;
    const hadOldPrice = pc?.hasChange && pc.oldPrice > 0;
    const oldMonthly = hadOldPrice
      ? (sub.period === "ежегодно" ? pc.oldPrice / 12 : pc.oldPrice)
      : current;
    before += oldMonthly;
    if (hadOldPrice && (!worst || pc.percentChange > worst.pc.percentChange)) {
      worst = { sub, pc };
    }
  }
  if (before <= 0 || now <= 0) return null;
  const percent = Math.round((now / before - 1) * 100);
  if (Math.abs(percent) < 1) return null;

  const up = percent > 0;
  return (
    <div className={`card flex flex-wrap items-center justify-between gap-4 border p-5 ${
      up ? "border-rose-500/20" : "border-emerald-500/20"
    }`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
          up ? "bg-rose-500/10 text-rose-400" : "bg-emerald-500/10 text-emerald-400"
        }`}>
          {up ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
        </div>
        <div>
          <h3 className={`font-bold ${up ? "text-rose-300" : "text-emerald-300"}`}>
            {up ? "Расходы на подписки выросли" : "Расходы на подписки снизились"} на {Math.abs(percent)}%
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {up
              ? `За последние 6 месяцев: с ${fmt(before)} до ${fmt(now)} ₽/мес. Проверьте, не подняли ли тариф сервисы из списка ниже.`
              : `За последние 6 месяцев: с ${fmt(before)} до ${fmt(now)} ₽/мес.`}
          </p>
        </div>
      </div>
      {up && worst && (
        <div className="rounded-xl bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300">
          {worst.sub.name}: {fmt(worst.pc.oldPrice)} ₽ → {fmt(worst.pc.newPrice)} ₽
          (+{worst.pc.percentChange}%)
        </div>
      )}
    </div>
  );
}
