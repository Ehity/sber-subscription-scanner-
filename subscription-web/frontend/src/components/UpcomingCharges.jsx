import { CalendarDays } from "lucide-react";

const fmt = (n) => Math.round(n).toLocaleString("ru-RU");

// «В сентябре», «В октябре 2027» — предложный падеж
const MONTHS_PREP = [
  "январе", "феврале", "марте", "апреле", "мае", "июне",
  "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
];

function addMonths(d, months) {
  const m = d.getMonth() + months;
  const year = d.getFullYear() + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const day = Math.min(d.getDate(), [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month]);
  return new Date(year, month, day);
}

/**
 * Календарь ближайших списаний: «В сентябре спишут 2 184 ₽:
 * 12-го Netflix 599, 15-го Плюс 399…» — на основе next_charge.
 */
export default function UpcomingCharges({ subscriptions }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // следующая дата списания: next_charge, докрученная до будущего.
  // Подписки с пометкой «похоже, уже отменена» в календаре не показываем
  const upcoming = subscriptions
    .filter((sub) => sub.active !== false)
    .map((sub) => {
      let d = new Date(sub.next_charge + "T00:00:00");
      if (Number.isNaN(d.getTime())) return null;
      let guard = 0;
      while (d < today && guard++ < 24) d = addMonths(d, 1);
      return { ...sub, date: d };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date || b.amount - a.amount);

  // группировка по месяцам
  const groups = [];
  for (const it of upcoming) {
    const key = `${it.date.getFullYear()}-${it.date.getMonth()}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, date: new Date(it.date), items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  const shown = groups.slice(0, 2);
  if (!shown.length) return null;

  return (
    <section className="card p-6">
      <div className="mb-4 flex items-center gap-2">
        <CalendarDays size={18} className="text-emerald-400" />
        <h2 className="font-bold text-white">Календарь ближайших списаний</h2>
      </div>
      <div className="space-y-4">
        {shown.map(({ date, items }) => {
          const total = items.reduce((acc, s) => acc + Math.abs(s.amount), 0);
          const inCurrentYear = date.getFullYear() === today.getFullYear();
          const monthLabel =
            "В " + MONTHS_PREP[date.getMonth()] +
            (inCurrentYear ? "" : ` ${date.getFullYear()}`);
          return (
            <div key={date.getMonth() + "-" + date.getFullYear()}>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-white">
                  {monthLabel} спишут {fmt(total)} ₽
                </h3>
                <span className="text-xs text-slate-500">{items.length} шт</span>
              </div>
              <div className="space-y-1.5">
                {items.map((s) => (
                  <div
                    key={s.id + s.date.getTime()}
                    className="flex items-center gap-3 rounded-xl bg-slate-800/40 px-3 py-2"
                  >
                    <span className="w-8 text-center text-sm font-bold text-emerald-400">
                      {s.date.getDate()}
                    </span>
                    <span className="text-base">{s.icon}</span>
                    <span className="flex-1 truncate text-sm text-slate-300">{s.name}</span>
                    <span className="text-sm font-semibold text-white">{fmt(s.amount)} ₽</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
