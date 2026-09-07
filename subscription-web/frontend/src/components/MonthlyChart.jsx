import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from "recharts";

const fmt = (n) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

export default function MonthlyChart({ data, mock = true, hasSubscriptions = true }) {
  // Если подписок нет и данные реальные (не демо) — показываем общие расходы
  const realData = !mock && !hasSubscriptions;
  const title = realData ? "Общие расходы по выписке" : "Расходы на подписки по месяцам";
  const subtitle = realData ? "Списания по всем транзакциям за последние 6 месяцев"
                            : "Реальные списания подписок за последние 6 месяцев";
  const label = realData ? "Расходы" : "Подписки";

  // Плоская серия (все месяцы одинаковые) не о чём не говорит — вместо
  // бессмысленного графика показываем компактную сводку.
  const spentValues = data.map((d) => d.spent);
  const isFlat = !realData && data.length > 1 && Math.max(...spentValues) === Math.min(...spentValues);

  if (isFlat) {
    const monthly = data[data.length - 1]?.spent ?? 0;
    return (
      <section className="card flex flex-wrap items-center justify-between gap-6 p-6">
        <div className="max-w-xl">
          <h2 className="font-bold text-white">Расходы на подписки стабильны</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Каждый месяц списывается одна и та же сумма, поэтому график здесь ничего
            не добавляет. Отмените лишние подписки — и эта цифра начнёт уменьшаться.
          </p>
        </div>
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-4xl font-black text-white">{fmt(monthly)}</span>
          <span className="text-sm text-slate-500">/ мес · {fmt(monthly * 12)} / год</span>
        </div>
      </section>
    );
  }

  return (
    <section className="card p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-bold text-white">{title}</h2>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="sberFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#21A038" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#21A038" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: "#64748B", fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#64748B", fontSize: 12 }} axisLine={false} tickLine={false}
                   width={56}
                   tickFormatter={(v) => `${Math.round(v).toLocaleString("ru-RU")} ₽`} />
            <Tooltip
              cursor={{ stroke: "#21A038", strokeWidth: 1, strokeDasharray: "4 4" }}
              contentStyle={{
                background: "#0E1526", border: "1px solid #1E293B",
                borderRadius: 12, color: "#E2E8F0",
              }}
              formatter={(v) => [fmt(v), label]}
            />
            <Area
              type="monotone"
              dataKey="spent"
              stroke="#21A038"
              strokeWidth={3}
              fill="url(#sberFill)"
              dot={{ r: 3, fill: "#21A038", stroke: "#0B0F1A", strokeWidth: 2 }}
              activeDot={{ r: 6, fill: "#21A038", stroke: "#E2E8F0", strokeWidth: 2 }}
              animationDuration={700}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
