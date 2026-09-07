import { TrendingDown } from "lucide-react";

const fmt = (n) => Math.round(n).toLocaleString("ru-RU");

function pluralSubs(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "подписки";
  return "подписок";
}

// «Кино и видео» → «видеосервиса», для остальных — название категории.
const CATEGORY_NICKNAMES = {
  "Кино и видео": "видеосервиса",
  "Музыка": "музыкального сервиса",
  "Облако": "облачного хранилища",
};

function nickname(category, count) {
  const nick = CATEGORY_NICKNAMES[category];
  if (!nick) return null;
  // 2-4 → «видеосервиса», 5+ и 11-14 → «видеосервисов»
  const mod10 = count % 10;
  const mod100 = count % 100;
  const plural = mod10 >= 5 || mod10 === 0 || (mod100 >= 11 && mod100 <= 14);
  if (!plural) return nick;
  return nick.replace(/а$/, "ов").replace(/я$/, "ев").replace(/о$/, "");
}

/**
 * Поиск дублирующих подписок: несколько активных подписок в одной категории
 * (например, Netflix + Кинопоиск + START — три видеосервиса одновременно).
 * Бизнес-ценность: «у вас 3 видеосервиса — 1 697 ₽/мес, оставьте один».
 */
export default function DuplicatesBanner({ subscriptions }) {
  const groups = new Map();
  for (const sub of subscriptions) {
    if (!sub.category || sub.category === "Прочее") continue;
    if (!groups.has(sub.category)) groups.set(sub.category, []);
    groups.get(sub.category).push(sub);
  }
  const duplicates = [...groups.entries()]
    .filter(([, subs]) => subs.length >= 2)
    .map(([category, subs]) => {
      const monthly = subs.reduce((acc, s) => acc + Math.abs(s.monthly_cost), 0);
      const cheapest = Math.min(...subs.map((s) => Math.abs(s.monthly_cost)));
      return {
        category,
        icon: subs[0].icon,
        subs,
        monthly,
        savings: monthly - cheapest,
      };
    })
    .sort((a, b) => b.monthly - a.monthly);

  if (!duplicates.length) return null;

  return (
    <section className="space-y-3">
      {duplicates.map(({ category, icon, subs, monthly, savings }) => {
        const nick = nickname(category, subs.length);
        const names = subs.map((s) => s.name).join(", ");
        return (
          <div
            key={category}
            className="card flex flex-wrap items-center justify-between gap-4 border-amber-500/20 p-5"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-xl">
                {icon}
              </div>
              <div>
                <h3 className="font-bold text-white">
                  {nick
                    ? `У вас ${subs.length} ${nick} — ${fmt(monthly)} ₽/мес`
                    : `У вас ${subs.length} ${pluralSubs(subs.length)} в категории «${category}» — ${fmt(monthly)} ₽/мес`}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Дублируют друг друга: {names}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 px-4 py-2.5 text-sm">
              <TrendingDown size={16} className="text-amber-400" />
              <span className="text-amber-300">
                Оставьте один — сэкономите {fmt(savings)} ₽/мес ({fmt(savings * 12)} ₽/год)
              </span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
