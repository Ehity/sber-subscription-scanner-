import { useRef, useState } from "react";
import { FileUp, Loader2, RotateCcw, CheckCircle2 } from "lucide-react";

export default function UploadZone({ onUploaded, onReset, mock, hasRealData, message }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleFile(file) {
    if (!file) return;
    if (!/\.(csv|txt|pdf)$/i.test(file.name) && !["text/csv", "application/pdf"].includes(file.type)) {
      setError("Поддерживаются форматы CSV и PDF (выписка СберБанк Онлайн)");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await onUploaded(file);
      if (data.mock) setError(data.message);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={`card cursor-pointer p-8 text-center transition-all duration-200 ${
          dragging
            ? "border-emerald-400 bg-emerald-500/10 scale-[1.01]"
            : "hover:border-slate-600 hover:bg-slate-900"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,.pdf,text/csv,application/pdf"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400">
          {loading ? (
            <Loader2 size={30} className="animate-spin" />
          ) : (
            <FileUp size={30} />
          )}
        </div>
        <h3 className="text-lg font-semibold text-white">
          {loading ? "Анализируем выписку…" : "Перетащите выписку или нажмите"}
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          CSV или PDF-выписка СберБанк Онлайн за 6 месяцев
        </p>
      </div>

      <div className="card flex flex-col justify-between p-6">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-white">
            <CheckCircle2 size={18} className="text-emerald-400" /> Статус анализа
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            {message || "Загрузите выписку из СберБанк Онлайн: История → Выписка → PDF/CSV"}
          </p>
          {error && (
            <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {error}
            </p>
          )}
        </div>
        {!mock && hasRealData && (
          <button
            onClick={onReset}
            className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white"
          >
            <RotateCcw size={15} /> Вернуть демо-данные
          </button>
        )}
      </div>
    </section>
  );
}
