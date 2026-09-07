import {
  buildLetter, detectSubscriptions, extractPdfPages, makeDemoPdf,
  monthlyExpenseSeriesAll, monthlyExpenseSeriesFromTxs, pagesToLines,
  parseCsvText, testStatementCsv, transactionsFromLines, transactionsFromPages,
} from "./lib/analyzer.js";

const BASE = "";
// "server" — есть backend (start_web.bat); "static" — анализ в браузере (GitHub Pages).
let mode = null;

async function detectMode() {
  if (mode) return mode;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    mode = res.ok ? "server" : "static";
  } catch {
    mode = "static";
  }
  return mode;
}

async function analyzeTransactions(txs) {
  const subs = detectSubscriptions(txs);
  if (!subs.length) {
    return {
      mock: false,
      subscriptions: [],
      monthly: monthlyExpenseSeriesAll(txs),
      total_monthly: 0,
      total_yearly: 0,
      message: `В выписке (${txs.length} транзакций) не найдено регулярных списаний — показаны общие расходы по выписке`,
    };
  }
  return {
    mock: false,
    subscriptions: subs,
    monthly: monthlyExpenseSeriesFromTxs(txs, subs),
    total_monthly: +subs.reduce((acc, s) => acc + Math.abs(s.monthly_cost), 0).toFixed(2),
    total_yearly: +subs.reduce((acc, s) => acc + Math.abs(s.yearly_cost), 0).toFixed(2),
    message: `Выписка: ${txs.length} транзакций, найдено подписок: ${subs.length}`,
  };
}

async function analyzeCsvText(text) {
  return analyzeTransactions(parseCsvText(text));
}

function emptyState() {
  return {
    mock: false,
    subscriptions: [],
    monthly: [],
    total_monthly: 0,
    total_yearly: 0,
    message: "Загрузите выписку, чтобы увидеть найденные подписки",
  };
}

export async function fetchSubscriptions() {
  if ((await detectMode()) === "static") {
    const saved = sessionStorage.getItem("scannerState");
    return saved ? JSON.parse(saved) : emptyState();
  }
  const res = await fetch(`${BASE}/api/subscriptions`);
  if (!res.ok) throw new Error("Не удалось получить данные");
  return res.json();
}

async function readFileText(file) {
  const buf = await file.arrayBuffer();
  for (const enc of ["utf-8", "windows-1251"]) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(buf);
      if (!text.includes("\uFFFD")) return text;
    } catch { /* попробуем следующую кодировку */ }
  }
  return new TextDecoder("windows-1251").decode(buf);
}

export async function uploadStatement(file) {
  if ((await detectMode()) === "server") {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Ошибка загрузки файла");
    return data;
  }
  // Браузерный режим: CSV и PDF анализируем на месте (pdf.js).
  const fname = (file.name || "").toLowerCase();
  try {
    if (fname.endsWith(".pdf")) {
      const buf = await file.arrayBuffer();
      const pages = await extractPdfPages(buf);
      // сначала колоночный разбор (табличные выписки), затем построчный
      let txs = transactionsFromPages(pages);
      if (!txs.length) txs = transactionsFromLines(pagesToLines(pages));
      if (!txs.length) {
        throw new Error("В PDF не найдено транзакций. Убедитесь, что это текстовая выписка (не скан).");
      }
      const result = await analyzeTransactions(txs);
      result.message = `Выписка «${file.name}»: ${txs.length} транзакций${result.subscriptions.length ? `, найдено подписок: ${result.subscriptions.length}` : ""}`;
      sessionStorage.setItem("scannerState", JSON.stringify(result));
      return result;
    }
    if (!fname.endsWith(".csv") && !fname.endsWith(".txt")) {
      throw new Error("Поддерживаются форматы CSV и PDF (выписка СберБанк Онлайн)");
    }
    const text = await readFileText(file);
    const result = await analyzeCsvText(text);
    sessionStorage.setItem("scannerState", JSON.stringify(result));
    return result;
  } catch (e) {
    throw new Error(e.message || "Не удалось разобрать файл");
  }
}

export async function resetToDemo() {
  if ((await detectMode()) === "server") {
    await fetch(`${BASE}/api/reset`, { method: "POST" });
  } else {
    sessionStorage.removeItem("scannerState");
  }
}

export async function generateLetter(sub) {
  if ((await detectMode()) === "server") {
    const res = await fetch(`${BASE}/api/generate-letter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sub.name, amount: sub.amount, period: sub.period }),
    });
    if (!res.ok) throw new Error("Не удалось сгенерировать письмо");
    return res.json();
  }
  return { letter: buildLetter({ name: sub.name, amount: sub.amount }) };
}

/** Тестовая выписка для превью (в браузерном режиме — без PDF). */
export async function fetchTestPreview() {
  if ((await detectMode()) === "server") {
    const res = await fetch(`${BASE}/api/generate-test-json`);
    if (!res.ok) throw new Error("Не удалось сгенерировать тестовую выписку");
    const data = await res.json();
    return { csv: data.csv_text, pdfUrl: base64ToPdfUrl(data.pdf_base64) };
  }
  const csv = testStatementCsv();
  const pdfBytes = makeDemoPdf(csv);
  const pdfUrl = URL.createObjectURL(new Blob([pdfBytes], { type: "application/pdf" }));
  return { csv, pdfUrl };
}

/** Загружает тестовую выписку на скан (в браузерном режиме — анализ на месте). */
export async function uploadTestToScan(csvText) {
  if ((await detectMode()) === "server") {
    const form = new FormData();
    const file = new File([new Blob([csvText], { type: "text/csv" })], "test_statement.csv", { type: "text/csv" });
    form.append("file", file);
    const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Ошибка загрузки тестовой выписки");
    return data;
  }
  const result = await analyzeCsvText(csvText);
  sessionStorage.setItem("scannerState", JSON.stringify(result));
  return result;
}

function base64ToPdfUrl(b64) {
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}
