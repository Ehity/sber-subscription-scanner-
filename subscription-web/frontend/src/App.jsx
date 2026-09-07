import { useEffect, useState } from "react";
import { Sparkles, LayoutGrid, Search } from "lucide-react";

import Header from "./components/Header.jsx";
import SavingsBanner from "./components/SavingsBanner.jsx";
import DuplicatesBanner from "./components/DuplicatesBanner.jsx";
import UpcomingCharges from "./components/UpcomingCharges.jsx";
import GrowthBanner from "./components/GrowthBanner.jsx";
import UploadZone from "./components/UploadZone.jsx";
import SubscriptionCard from "./components/SubscriptionCard.jsx";
import LetterModal from "./components/LetterModal.jsx";
import MonthlyChart from "./components/MonthlyChart.jsx";
import PreviewModal from "./components/PreviewModal.jsx";
import { fetchSubscriptions, uploadStatement, resetToDemo, fetchTestPreview, uploadTestToScan } from "./api.js";

export default function App() {
  const [data, setData] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [modalSub, setModalSub] = useState(null);
  const [cancelled, setCancelled] = useState([]);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [previewPdfUrl, setPreviewPdfUrl] = useState(null);

  async function load() {
    try {
      const d = await fetchSubscriptions();
      setData(d);
      setConnected(true);
      setCancelled([]);
      setError(null);
    } catch {
      setConnected(false);
      setError("Не удалось подключиться к API. Запустите backend: uvicorn main:app --port 8000");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleUploaded(file) {
    const d = await uploadStatement(file);
    setData(d);
    setCancelled([]);
    return d;
  }

  async function handleReset() {
    await resetToDemo();
    load();
  }

    function handleCancel(sub) {
    setModalSub(sub);
    setCancelled((prev) => (prev.includes(sub.id) ? prev : [...prev, sub.id]));
  }

  async function handleGenerateTest() {
    try {
      const prev = await fetchTestPreview();
      setPreviewData({ csv: prev.csv });
      setPreviewPdfUrl(prev.pdfUrl);
      setPreviewVisible(true);
    } catch (e) {
      setError(e.message);
    }
  }

  function handleClosePreview() {
    setPreviewVisible(false);
    setPreviewData(null);
    if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl);
    setPreviewPdfUrl(null);
  }

  async function handleSendToScan() {
    if (!previewData) return;
    setPreviewVisible(false);
    setCancelled([]);
    setError(null);
    try {
      // Заново сканируем выписку на сервере и используем свежий результат.
      const result = await uploadTestToScan(previewData.csv);
      setData(result);
    } catch (e) {
      setError(e.message);
      load();
    }
    setPreviewData(null);
    if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl);
    setPreviewPdfUrl(null);
  }

  if (!data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <div className="sber-gradient h-14 w-14 animate-pulse rounded-2xl" />
        <p className="text-slate-500">
          {error || "Подключаемся к серверу…"}
        </p>
        {error && (
          <button onClick={load} className="rounded-xl bg-emerald-500/10 px-4 py-2 text-sm text-emerald-400">
            Повторить
          </button>
        )}
      </div>
    );
  }

  const active = data.subscriptions.filter((s) => !cancelled.includes(s.id));
  const savedYearly = data.subscriptions
    .filter((s) => cancelled.includes(s.id))
    .reduce((acc, s) => acc + s.yearly_cost, 0);
  // Потенциальная экономия — сумма всех подписок, которые можно отменить
  const potentialSavingsYearly = data.subscriptions.reduce((acc, s) => acc + s.yearly_cost, 0);

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
        <SavingsBanner
          totalYearly={savedYearly > 0 ? savedYearly : potentialSavingsYearly}
          totalMonthly={(savedYearly > 0 ? savedYearly : potentialSavingsYearly) / 12}
          cancelledCount={cancelled.length}
        />

        <GrowthBanner subscriptions={active} />
        <DuplicatesBanner subscriptions={active} />
        <UpcomingCharges subscriptions={active} />

        <UploadZone
          onUploaded={handleUploaded}
          onReset={handleReset}
          mock={data.mock}
          hasRealData={data.subscriptions.length > 0 || data.monthly.some((m) => m.spent > 0)}
          message={data.message}
        />

        <section>
          <div className="mb-4 flex items-center gap-2">
            <LayoutGrid size={18} className="text-emerald-400" />
            <h2 className="text-lg font-bold text-white">
              Найденные подписки
              <span className="ml-2 rounded-full bg-slate-800 px-2.5 py-0.5 text-sm font-semibold text-slate-400">
                {active.length}
              </span>
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {active.map((sub) => (
              <SubscriptionCard key={sub.id} sub={sub} onCancel={handleCancel} />
            ))}
          </div>
          {active.length === 0 && (
            <div className="card flex flex-col items-center gap-2 p-10 text-center">
              {cancelled.length > 0 ? (
                <>
                  <Sparkles size={28} className="text-emerald-400" />
                  <p className="font-semibold text-white">Все подписки отмечены к отмене!</p>
                  <p className="text-sm text-slate-500">
                    Экономия {Math.round(savedYearly).toLocaleString("ru-RU")} ₽ в год — скопируйте
                    заявления из писем и отправьте в поддержку.
                  </p>
                </>
              ) : (
                <>
                  <Search size={28} className="text-amber-400" />
                  <p className="font-semibold text-white">Подписок не найдено</p>
                  <p className="text-sm text-slate-500">
                    В выписке не обнаружено регулярных списаний — график показывает общие расходы.
                    Попробуйте загрузить выписку за период с подписками.
                  </p>
                  <button
                    onClick={handleGenerateTest}
                    className="mt-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 transition hover:brightness-110"
                  >
                    Сгенерировать тестовую выписку
                  </button>
                </>
              )}
            </div>
          )}
        </section>

        <MonthlyChart data={data.monthly} mock={data.mock} hasSubscriptions={data.subscriptions.length > 0} />

        <footer className="pb-6 pt-2 text-center text-xs text-slate-600">
          Сбер.Сканер Подписок · хакатонный MVP · FastAPI + React + Tailwind CSS
        </footer>
      </main>

      {modalSub && <LetterModal sub={modalSub} onClose={() => setModalSub(null)} />}

      {previewVisible && previewData && (
        <PreviewModal
          csv={previewData.csv || ""}
          pdfUrl={previewPdfUrl}
          onClose={handleClosePreview}
          onSubmit={handleSendToScan}
        />
      )}
    </div>
  );
}
