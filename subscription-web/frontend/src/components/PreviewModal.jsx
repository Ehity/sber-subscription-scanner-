import { useEffect, useState } from "react";
import { X, Download, FileText, FileImage, Loader2, Table2, FileUp } from "lucide-react";

// Мобильные браузеры (iOS и Android) не показывают PDF внутри <object>/<embed> —
// только скачивание. На десктопе встроенный просмотр работает.
const isMobileDevice =
  /Android|iPad|iPhone|iPod|Opera Mini|IEMobile/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

export default function PreviewModal({ csv, pdfUrl, onClose, onSubmit }) {
  const [activeTab, setActiveTab] = useState("csv");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = csv
    .split("\n")
    .filter((l) => l.trim())
    .map((line, i) => {
      const cols = line.split(",");
      return cols.map((c, j) => (
        <td
          key={j}
          className={`px-3 py-1.5 text-sm ${
            i === 0
              ? "font-semibold text-white"
              : "text-slate-300"
          }`}
        >
          {c}
        </td>
      ));
    });

  async function handleSendToScan() {
    setLoading(true);
    try {
      await onSubmit();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl bg-[#0E1526] p-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
              <FileText size={18} />
            </div>
            <h2 className="text-lg font-bold text-white">
              Тестовая выписка — подтверждение загрузки
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-800 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex border-b border-slate-800 px-6">
          <button
            onClick={() => setActiveTab("csv")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm transition ${
              activeTab === "csv"
                ? "border-b-2 border-emerald-400 text-emerald-400"
                : "text-slate-500 hover:text-white"
            }`}
          >
            <Table2 size={15} /> CSV-таблица
          </button>
          {pdfUrl && (
            <button
              onClick={() => setActiveTab("pdf")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm transition ${
                activeTab === "pdf"
                  ? "border-b-2 border-emerald-400 text-emerald-400"
                  : "text-slate-500 hover:text-white"
              }`}
            >
              <FileImage size={15} /> PDF-просмотр
            </button>
          )}
        </div>
        {!pdfUrl && (
          <p className="px-6 pt-3 text-xs text-slate-500">
            PDF-версия демо-выписки доступна в серверной версии (start_web.bat) —
            в браузерном режиме показана CSV-таблица.
          </p>
        )}

        <div className="max-h-[55vh] overflow-y-auto px-6 py-4">
          {activeTab === "csv" && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                {rows.map((row, i) => (
                  <tr
                    key={i}
                    className={
                      i === 0
                        ? "bg-slate-800"
                        : i % 2 === 0
                        ? "bg-[#0E1526]"
                        : "bg-[#141A2A]"
                    }
                  >
                    {row}
                  </tr>
                ))}
              </table>
            </div>
          )}

          {activeTab === "pdf" && pdfUrl && (
            isMobileDevice ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <FileImage size={36} className="text-emerald-400" />
                <p className="max-w-xs text-center text-sm text-slate-400">
                  Мобильные браузеры не показывают PDF внутри страницы.
                  Скачайте файл — он откроется во встроенном просмотрщике.
                </p>
                <a
                  href={pdfUrl}
                  download="test_statement.pdf"
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20"
                >
                  <Download size={16} /> Скачать PDF
                </a>
              </div>
            ) : (
              <div className="flex items-center justify-center">
                <object
                  data={pdfUrl}
                  type="application/pdf"
                  className="h-[55vh] w-full"
                  title="PDF Preview"
                >
                  <p className="text-center text-slate-500">
                    Ваш браузер не поддерживает просмотр PDF.{" "}
                    <a
                      href={pdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-400"
                    >
                      Скачать PDF
                    </a>
                  </p>
                </object>
              </div>
            )
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 px-6 py-4">
          <button
            onClick={() => {
              const blob = new Blob([csv], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "test_statement.csv";
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white"
          >
            <Download size={16} /> Скачать CSV
          </button>
          <button
            onClick={handleSendToScan}
            disabled={loading}
            className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 transition hover:brightness-110 disabled:opacity-40"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <FileUp size={16} />
            )}
            {loading ? "Сканируем…" : "Отправить на скан"}
          </button>
        </div>
      </div>
    </div>
  );
}