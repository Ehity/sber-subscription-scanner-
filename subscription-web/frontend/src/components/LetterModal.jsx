import { useEffect, useState } from "react";
import { Copy, Check, X, Loader2, Scale } from "lucide-react";

export default function LetterModal({ sub, onClose }) {
  const [letter, setLetter] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    import("../api").then(async ({ generateLetter }) => {
      try {
        const data = await generateLetter(sub);
        if (alive) setLetter(data.letter);
      } catch (e) {
        if (alive) setError(e.message);
      }
    });
    return () => {
      alive = false;
    };
  }, [sub]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(letter);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = letter;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl bg-[#0E1526] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
              <Scale size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">
                Заявление на отмену «{sub.name}»
              </h2>
              <p className="text-xs text-slate-500">
                Со ссылками на ст. 32 Закона «О защите прав потребителей» и ст. 782 ГК РФ
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-800 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-slate-800 bg-[#0B0F1A] p-4">
          {error ? (
            <p className="text-sm text-rose-400">{error}</p>
          ) : letter ? (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-300">
              {letter}
            </pre>
          ) : (
            <div className="flex items-center justify-center gap-2 py-10 text-slate-500">
              <Loader2 className="animate-spin" size={18} /> Генерируем текст…
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white"
          >
            Закрыть
          </button>
          <button
            onClick={copyText}
            disabled={!letter}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 transition hover:brightness-110 disabled:opacity-40"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? "Скопировано!" : "Скопировать текст"}
          </button>
        </div>
      </div>
    </div>
  );
}
