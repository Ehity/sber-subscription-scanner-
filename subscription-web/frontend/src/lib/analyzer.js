// Порт analyzer.py + services_db.py на JavaScript — позволяет работать
// полностью в браузере (GitHub Pages) без backend.

import { detectSubscriptionPriceChange } from "./subscriptionPriceChange.js";

// pdf.js грузим лениво: модуль анализатора остаётся пригодным для Node-тестов.
let _pdfjs = null;
async function getPdfjs() {
  if (!_pdfjs) {
    const [lib, { default: workerUrl }] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]);
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    _pdfjs = lib;
  }
  return _pdfjs;
}

/**
 * Извлекает из PDF координаты всех текстовых фрагментов, по странице на массив.
 * Координаты нужны колоночному разбору: в табличных выписках соседние колонки
 * склеиваются в один текст, и по одному тексту их уже не разделить.
 */
export async function extractPdfPages(buf) {
  let pdf;
  try {
    const pdfjsLib = await getPdfjs();
    pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  } catch (e) {
    console.error(e);
    throw new Error(
      "Не удалось обработать PDF в этом браузере. Попробуйте обновить iOS/браузер или загрузите CSV-выписку."
    );
  }
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .filter((it) => typeof it.str === "string" && it.str.trim() !== "")
        .map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width || 0,
          h: it.height || Math.abs(it.transform[3]) || 10,
        }))
    );
  }
  return pages;
}

/** Склеивает элементы одной визуальной строки, ставя пробел по зазору X. */
function joinLineItems(line) {
  let out = "";
  let prevEnd = null;
  for (const it of line) {
    // зазор шире примерно четверти кегля — граница слова или колонки
    if (prevEnd !== null && it.x - prevEnd > (it.h || 10) * 0.22 && !/\s$/.test(out)) out += " ";
    out += it.str;
    prevEnd = it.x + (it.w || 0);
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Строки текста PDF-выписки — запасной путь, когда таблица не распознана. */
export async function extractPdfLines(buf) {
  const pages = await extractPdfPages(buf);
  return pagesToLines(pages);
}

export function pagesToLines(pages) {
  const lines = [];
  for (const items of pages) {
    for (const line of groupItemsIntoLines(items)) {
      const text = joinLineItems(line);
      if (text) lines.push(text);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Разбор PDF-выписки: токенайзер сумм + сборка операций из строк
// ---------------------------------------------------------------------------

// Служебные строки шапки/подвала выписки — не операции.
const PDF_SKIP_RE = /продолжение|страниц|сформирова|справк|выписк|сч[её]т\b|доступн|баланс|всего|итого|период|владелец|статус|реквизит|валюта|назначение|остаток|номер сч|дата откр|дата закрыт|действителен|расшифровк|дата операции|описание операц|категория|сумма в валюте/i;
const PDF_DATE_RE = /\b(\d{2}[./]\d{2}[./]\d{2,4})\b/;
const PDF_TIME_ONLY_RE = /^[\d\s:.,+−–-]+$/;
const AUTH_CODE_RE = /^\d{4,8}\b\s*/;
const OP_BY_CARD_RE = /\s*Операция по карте(?:\s*\*{2,}[\dx]+)?\s*$/i;

const NBSP = "\u00a0";
const NNBSP = "\u202f";
const SPACES = ` ${NBSP}${NNBSP}`;

/**
 * Маскирует пробелами всё, что похоже на число, но суммой не является:
 * даты, время, маски карт, номера счетов и телефонов. Длина строки
 * сохраняется, поэтому индексы найденных сумм остаются валидными.
 */
export function maskNonMoney(s) {
  const blank = (m) => " ".repeat(m.length);
  return String(s)
    .replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}/g, blank) // 05.03.2026
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, blank) // 10:04:12 — время
    .replace(/\*{2,}[\s]?\d{2,6}/g, blank) // **** 1234 — маска карты
    .replace(/\+?\d[\d()-]{9,}\d/g, blank) // телефоны вида +7(999)123-45-67
    .replace(/\d{10,}/g, blank); // номера счетов и договоров
}

// Сумма: необязательный знак, целая часть (с группами по 3) и копейки.
const MONEY_SCAN_RE = new RegExp(
  `([+\\-−–—])?[${SPACES}]?(\\d{1,3}(?:[${SPACES}]\\d{3})+|\\d{1,9})(?:([.,])(\\d{1,2}))?(?:[${SPACES}]{0,2}(₽|руб\\.|руб|rub|р\\.))?`,
  "gi"
);

/**
 * Находит суммы в строке. `strict` требует явного признака денег
 * (знак, валюта, копейки или разделитель тысяч) — так номера договоров
 * и коды авторизации не превращаются в миллионы.
 */
export function moneyMatches(s, strict = true) {
  const src = String(s);
  const masked = maskNonMoney(src);
  const out = [];
  MONEY_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_SCAN_RE.exec(masked)) !== null) {
    if (!m[2]) {
      MONEY_SCAN_RE.lastIndex = m.index + 1;
      continue;
    }
    const [, signRaw, wholeRaw, , fracRaw, currRaw] = m;
    const numStart = m.index + m[0].indexOf(wholeRaw[0]);
    // начало токена — знак, если он есть, иначе первая цифра (пробел не в счёт)
    const tokenStart = signRaw ? m.index + m[0].indexOf(signRaw) : numStart;
    const prev = masked[tokenStart - 1];
    // число не может продолжать другое число
    if (prev && /[\d.,:/]/.test(prev)) {
      MONEY_SCAN_RE.lastIndex = m.index + 1;
      continue;
    }
    const after = masked.slice(m.index + m[0].length);
    if (/^[\d:/]/.test(after)) {
      MONEY_SCAN_RE.lastIndex = m.index + 1;
      continue;
    }
    const grouped = new RegExp(`[${SPACES}]`).test(wholeRaw);
    const whole = wholeRaw.replace(new RegExp(`[${SPACES}]`, "g"), "");
    const kopecks = fracRaw && fracRaw.length === 2;
    const sign = (signRaw || "").trim();
    // признак настоящей суммы: знак, валюта, копейки или разделитель тысяч
    if (strict && !(sign || currRaw || kopecks || grouped)) {
      MONEY_SCAN_RE.lastIndex = m.index + Math.max(1, m[0].length);
      continue;
    }
    let amount = parseInt(whole, 10);
    if (Number.isNaN(amount)) {
      MONEY_SCAN_RE.lastIndex = m.index + 1;
      continue;
    }
    if (fracRaw) amount += parseInt(fracRaw, 10) / 10 ** fracRaw.length;
    if (amount >= 1e8) continue; // такие суммы в личной выписке не встречаются
    out.push({
      sign,
      amount: Math.round(amount * 100) / 100,
      start: tokenStart,
      end: m.index + m[0].length,
      currency: !!currRaw,
    });
  }
  return out;
}

export function parsePdfDateStr(s) {
  const m = String(s).match(/^(\d{2})[./](\d{2})[./](\d{2,4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const d = new Date(y, +m[2] - 1, +m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

// MCC-коды торговых точек, где подписок не бывает: продукты, общепит,
// аптеки, АЗС, транспорт, розница, медицина, наличные, ЖКХ.
const NON_SUB_MCC = new Set([
  "4111", "4112", "4121", "4131", "4784", "4789", "3990", // транспорт
  "4829", "6010", "6011", "6012", "6051", // переводы и наличные
  "4900", // ЖКХ и коммунальные услуги
  "5300", "5310", "5311", "5331", "5399", // универмаги и товары повседневного спроса
  "5411", "5412", "5422", "5441", "5451", "5462", "5499", // продукты
  "5541", "5542", "5983", // АЗС
  "5651", "5661", "5691", "5699", "5641", "5621", "5611", // одежда и обувь
  "5712", "5719", "5722", "5732", "5200", "5211", "5231", "5251", "5261", // дом и ремонт
  "5811", "5812", "5813", "5814", // кафе и рестораны
  "5912", "5122", "5292", "5295", "5977", "7230", // аптеки, косметика, парикмахерские
  "8011", "8021", "8031", "8042", "8043", "8049", "8062", "8071", "8099", // медицина
]);

// Категория операции из выписки Сбера: сюда подписки не попадают.
const NON_SUB_CATEGORY_RE = /жкх|коммунальн|супермаркет|продукт|ресторан|кафе|фаст[- ]?фуд|транспорт|топлив|азс|такси|аптек|здоровь|красот|одежд|обувь|наличн|перевод|снятие|дом и ремонт|всё для дома|все для дома|автоуслуг|образован|налог|штраф/i;

// От описания остался только город или страна — сервиса в нём нет.
const CITY_ONLY_RE = /^(?:moscow|moskva|chita|ekaterinburg|sankt|peterburg|piter|novosibirsk|kazan|city|town|rus|ru|us)(?:[\s,]+(?:moscow|moskva|chita|ekaterinburg|sankt|peterburg|piter|rus|ru|us))*$/i;

function cleanDesc(desc) {
  let s = String(desc).replace(OP_BY_CARD_RE, "");
  s = s.replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}/g, " "); // даты
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " "); // время
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(AUTH_CODE_RE, ""); // код авторизации в начале
  return s.replace(new RegExp(`^[${SPACES}−.,–-]+|[${SPACES}−.,–-]+$`, "g"), "").trim();
}

/** Текст строки без дат и без найденных сумм. */
function lineText(line, moneys) {
  let out = "";
  let pos = 0;
  for (const mn of moneys) {
    out += line.slice(pos, mn.start) + " ";
    pos = mn.end;
  }
  out += line.slice(pos);
  return cleanDesc(out);
}

/**
 * Сумма операции vs остаток по счёту.
 * В выписке остаток стоит последним и всегда без знака, поэтому:
 *  - если в строке есть суммы со знаком — операция это последняя из них;
 *  - иначе при двух и более числах последнее считаем остатком.
 */
function pickAmount(moneys) {
  if (!moneys.length) return null;
  const signed = moneys.filter((m) => m.sign);
  if (signed.length) return signed[signed.length - 1];
  if (moneys.length >= 2) return moneys[moneys.length - 2];
  return moneys[0];
}

const isDebitSign = (sign) => !!sign && "−–—-".includes(sign);

/** Строки PDF-выписки -> [{date, amount, description, category, balance}]. */
export function transactionsFromLines(lines) {
  const rows = lines.map((l) => String(l).replace(/\s+$/g, "")).filter((l) => l.trim());

  const records = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.amount !== null) records.push(cur);
    cur = null;
  };

  for (const line of rows) {
    const isSkip = PDF_SKIP_RE.test(line);
    const mDate = PDF_DATE_RE.exec(line);
    const moneys = moneyMatches(line);
    const text = lineText(line, moneys);

    if (mDate && !isSkip) {
      const d = parsePdfDateStr(mDate[1]);
      if (d) {
        flush();
        const chosen = pickAmount(moneys);
        cur = {
          date: d,
          amount: chosen ? chosen.amount : null,
          sign: chosen ? chosen.sign : "",
          balance: moneys.length >= 2 ? moneys[moneys.length - 1].amount : null,
          category: text && !PDF_TIME_ONLY_RE.test(text) ? text : "",
          descParts: [],
        };
        continue;
      }
    }

    if (!cur) continue;

    // строка-продолжение: мерчант, код авторизации, город
    if (moneys.length && cur.amount === null) {
      const chosen = pickAmount(moneys);
      cur.amount = chosen.amount;
      cur.sign = chosen.sign;
      if (moneys.length >= 2) cur.balance = moneys[moneys.length - 1].amount;
    }
    if (text && !isSkip && !PDF_TIME_ONLY_RE.test(text)) cur.descParts.push(text);
  }
  flush();

  // Направление операции: по знаку, иначе — по изменению остатка по счёту.
  const txs = [];
  let prevBalance = null;
  for (const r of records) {
    let debit = true;
    if (r.sign) {
      debit = isDebitSign(r.sign);
    } else if (r.balance !== null && prevBalance !== null) {
      // остаток изменился ровно на сумму операции — направление известно точно
      const delta = Math.round((r.balance - prevBalance) * 100) / 100;
      if (Math.abs(delta + r.amount) < 0.02) debit = true;
      else if (Math.abs(delta - r.amount) < 0.02) debit = false;
    }
    if (r.balance !== null) prevBalance = r.balance;
    if (!debit || !r.amount) continue;
    // описание: мерчант со строк-продолжений важнее названия категории
    const merchant = cleanDesc(r.descParts.join(" "));
    const raw = merchant || r.category;
    if (!raw) continue;
    const cleaned = cleanMerchant(raw);
    if (!cleaned.name) continue;
    txs.push({
      date: r.date,
      amount: r.amount,
      description: cleaned.name.slice(0, 120),
      category: (merchant ? r.category : "").slice(0, 60),
      mcc: cleaned.mcc,
      raw: raw.slice(0, 200),
    });
  }
  return txs.sort((a, b) => a.date - b.date);
}

// Движение денег между своими счетами и наличные — не подписки
const INTERNAL_RE = /перевод|банкомат|вклад|наличн|пополнен|списание|сбербанк|стипендия|kartavklad|vklad|sberbank onl|qr[- ]?код|покупка по qr|perevod|popolnen|nalich|vnutrenn|vneshn|raspory|тбанк|т-?банк|tbank|универсальн|альфа|alfa|совком|sovcom|втб\b|vtb|райф|raif/i;
// Платежи ЖКХ и бюджетных учреждений (в т.ч. транслит из СБП-выписок:
// USLU = «услуги», UCHREZD = «учреждение») — регулярные, но не подписки
const UTILITY_RE = /жкх|гис жкх|тсж|квартплат|содержан|жиль[яе]|капремонт|капрем|водоканал|водоснабж|водоотвед|теплоснабж|теплосеть|энергосбыт|энергосб[у]|газпром|межрегионгаз|горгаз|еирц|еркц|расч[её]тн|домофон|тко|обращен|вывоз|услуг|услу|uslu|uchrezd|учрежд|жилищ|домоуправл|жэу|жэк|жилсервис|госуслуг|штраф|гибдд|налог|пошлин|прочие|prochie|операци/i;
// Покупки в рознице и по QR (даже регулярные и одинаковые) — не подписки
const RETAIL_RE = /пятер|pyater|красное[ &-]*белое|krasnoe|магнит|magnit|монетк|monetka|fixprice|дикси|dixy|лента|lenta|озон|ozon|wildberries|вайлдберр|аптек|apteka|aptech|starbucks|старбакс|kfc|макдоналдс|mcdonalds|cinemapark|cinema park|бургер|burger|перекрест|perekrestok|вкусно и точка|vkusnoitochka|столовая|кофейн|coffe|coffee|пицц|pizza|pitstsa|шаурма|shaurma|продукт|produkt|prodmiks|магазин|market|супермаркет|ашан|auchan|вкусвилл|vkusvill|светофор|svetofor|додо|dodo|rostics|ростикс|азс|лукойл|роснефть|gazprom neft|такси|taxi/i;

// ---------------------------------------------------------------------------
// Колоночный разбор табличных выписок (Совкомбанк, Сбер и т.п.)
//
// Строковые регулярки не справляются с таблицами: соседние колонки склеиваются
// («40817810550223167389» + «0.00» → одно число), а назначение платежа лежит
// на отдельных строках выше и ниже строки с датой. Поэтому колонки ищем по
// заголовку таблицы и раскладываем текст по ним геометрически.
// ---------------------------------------------------------------------------

// Роли колонок по тексту заголовка. Порядок важен: сначала точные, потом общие.
const COLUMN_ROLES = [
  ["date", /дата|дат[аы]\s*,?\s*врем/i],
  ["balance", /остаток|баланс|входящ|исходящ/i],
  ["debit", /дебет|расход|списан|уменьшен|снят/i],
  ["credit", /кредит|приход|поступлен|зачислен|увеличен|пополнен/i],
  ["amount", /сумма|amount/i],
  ["category", /категор/i],
  ["description", /назначен|описан|получател|детал|коммент|контрагент|мерчант/i],
  ["account", /^сч[её]т/i],
];

function roleOf(title) {
  for (const [role, re] of COLUMN_ROLES) if (re.test(title)) return role;
  return null;
}

/** Разбор одного числа из ячейки: «1,000.00», «5 480,00», «641.00» → число. */
export function parseCellNumber(text) {
  const s = String(text).replace(/[\s  ₽]|руб\.?|RUB/gi, "");
  if (!/^[+\-−–—]?[\d.,]*\d$/.test(s)) return null;
  const sign = /^[-−–—]/.test(s) ? -1 : 1;
  const body = s.replace(/^[+\-−–—]/, "");
  const lastSep = Math.max(body.lastIndexOf("."), body.lastIndexOf(","));
  let whole = body;
  let frac = "";
  // разделитель считается десятичным, только если после него 1–2 цифры
  if (lastSep >= 0 && body.length - lastSep - 1 <= 2 && body.length - lastSep - 1 >= 1) {
    whole = body.slice(0, lastSep);
    frac = body.slice(lastSep + 1);
  }
  whole = whole.replace(/[.,]/g, "");
  if (!whole && !frac) return null;
  const value = parseInt(whole || "0", 10) + (frac ? parseInt(frac, 10) / 10 ** frac.length : 0);
  return Number.isNaN(value) ? null : sign * Math.round(value * 100) / 100;
}

/** Элементы страницы -> визуальные строки (по координате Y). */
export function groupItemsIntoLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = [];
  let curY = null;
  for (const it of sorted) {
    const tol = Math.max(2, (it.h || 10) * 0.5);
    if (curY !== null && Math.abs(it.y - curY) > tol) {
      if (cur.length) lines.push(cur.sort((a, b) => a.x - b.x));
      cur = [];
    }
    cur.push(it);
    curY = it.y;
  }
  if (cur.length) lines.push(cur.sort((a, b) => a.x - b.x));
  return lines;
}

const headerLineText = (line) => line.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
const DATE_CELL_RE = /^\s*(\d{2}[./]\d{2}[./]\d{2,4})/;
const DATE_TOKEN_RE = /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/;

/** Строка операции: начинается с даты. */
const isDataLine = (line) => line.length > 0 && DATE_TOKEN_RE.test(line[0].str.trim());

/**
 * Полосы колонок по вертикальным просветам в строках операций.
 * Заголовок для этого не годится: в одних выписках слова заголовка одной
 * колонки разделены пробелами («Дата и время операции»), в других соседние
 * колонки стоят вплотную («Дата,время» и «Счет»). Данные же выровнены всегда.
 */
function columnBandsFromData(dataLines, gutter = 2) {
  const spans = [];
  for (const line of dataLines) {
    for (const it of line) spans.push([it.x, it.x + (it.w || 0)]);
  }
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const bands = [[spans[0][0], spans[0][1]]];
  for (const [a, b] of spans.slice(1)) {
    const last = bands[bands.length - 1];
    if (a - last[1] < gutter) last[1] = Math.max(last[1], b);
    else bands.push([a, b]);
  }
  return bands;
}

/** Ищет строку-заголовок таблицы и возвращает колонки [{x0, title, role}]. */
export function detectColumns(lines) {
  const dataLines = lines.filter(isDataLine);
  for (let i = 0; i < lines.length; i++) {
    if (isDataLine(lines[i])) continue;
    const roles = new Set();
    for (const it of lines[i]) {
      const r = roleOf(it.str);
      if (r) roles.add(r);
    }
    const hasMoneyRole = ["debit", "credit", "amount", "balance"].some((r) => roles.has(r));
    if (roles.size < 2 || !hasMoneyRole) continue;

    // шапка бывает в две-три строки («Дата и время» / «операции»): берём
    // соседние строки без дат и без сумм в тех же координатах
    const headerWords = [...lines[i]];
    const hy = lines[i][0].y;
    const hh = lines[i][0].h || 10;
    for (const j of [i - 2, i - 1, i + 1, i + 2]) {
      const ln = lines[j];
      if (!ln || isDataLine(ln)) continue;
      if (Math.abs(ln[0].y - hy) > hh * 2.6) continue;
      if (ln.some((it) => /\d/.test(it.str))) continue;
      headerWords.push(...ln);
    }

    const columns = buildColumns(headerWords, dataLines, lines[i]);
    const roleSet = new Set(columns.map((c) => c.role).filter(Boolean));
    if (roleSet.size >= 2 && roleSet.has("date")) {
      // низ шапки: заголовок бывает в две строки, и вторая строка не должна
      // попасть в описание первой операции
      const headerY = Math.min(...headerWords.map((w) => w.y));
      return { columns, headerIndex: i, headerY };
    }
  }
  return null;
}

/** Полосы данных + роли из слов заголовка. */
function buildColumns(headerWords, dataLines, headerLine) {
  let bands = columnBandsFromData(dataLines);
  if (bands.length < 2) {
    // операций на странице нет — раскладываем по словам заголовка
    bands = columnBandsFromData([headerLine], 10);
  }
  const overlap = (a, b, band) => Math.min(b, band[1]) - Math.max(a, band[0]);
  const titles = bands.map(() => []);
  for (const w of headerWords) {
    let best = -1;
    let bestVal = -Infinity;
    bands.forEach((band, i) => {
      const ov = overlap(w.x, w.x + (w.w || 0), band);
      if (ov > bestVal) { bestVal = ov; best = i; }
    });
    if (best >= 0) titles[best].push(w);
  }

  // полоса без слов заголовка — это хвост соседней колонки (описание
  // переносится по строкам и рвёт полосу на куски), приклеиваем влево
  const merged = [];
  bands.forEach((band, i) => {
    if (titles[i].length || !merged.length) merged.push({ band: [...band], words: titles[i] });
    else merged[merged.length - 1].band[1] = band[1];
  });
  // полосы левее первого заголовка приклеиваем вправо
  while (merged.length > 1 && !merged[0].words.length) {
    merged[1].band[0] = merged[0].band[0];
    merged.shift();
  }

  const columns = [];
  for (const m of merged) {
    const words = m.words.sort((a, b) => a.x - b.x || b.y - a.y);
    // в одной полосе могут стоять заголовки нескольких колонок, если между
    // ними нет просвета («Счет» / «Входящий остаток» / «Дебет»). Новую
    // колонку начинает слово, чья роль отличается от роли текущей группы.
    const groups = [];
    for (const w of words) {
      const r = roleOf(w.str);
      const cur = groups[groups.length - 1];
      // колонки разнесены по горизонтали: слова одного заголовка стоят вплотную
      if (!cur || (r && cur.role && r !== cur.role && w.x - cur.x >= 20)) {
        groups.push({ x: w.x, role: r, words: [w] });
      } else {
        cur.words.push(w);
        if (!cur.role) cur.role = r;
      }
    }
    if (!groups.length) {
      columns.push({ x0: m.band[0], x1: m.band[1], title: "", role: null });
      continue;
    }
    groups.forEach((g, i) => {
      const x0 = i === 0 ? m.band[0] : g.x;
      const x1 = i + 1 < groups.length ? groups[i + 1].x : m.band[1];
      const title = g.words.sort((a, b) => b.y - a.y || a.x - b.x).map((w) => w.str).join(" ");
      columns.push({ x0, x1, title, role: roleOf(title) });
    });
  }
  return columns.sort((a, b) => a.x0 - b.x0);
}

// Одно аккуратное число: «39 000,00», «1,000.00», «-599,00». Такой текст
// колонкам не принадлежит частично — его нельзя резать по границе.
const WHOLE_NUMBER_RE = new RegExp(`^[+\\-−–—]?\\d{1,3}(?:[${SPACES},.]\\d{3})*(?:[.,]\\d{1,2})?$`);

/**
 * Делит текстовый фрагмент, накрывший несколько колонок, на части с оценкой
 * координат. Ширина символа считается средней по фрагменту — этого хватает,
 * чтобы отнести каждую часть к своей колонке.
 */
function splitWideItem(it, boundaries) {
  const charW = it.w / Math.max(1, it.str.length);
  const pieces = [];
  if (/\s/.test(it.str.trim())) {
    // есть пробелы — режем по словам, так точнее всего
    const re = /\S+/g;
    let m;
    while ((m = re.exec(it.str)) !== null) {
      pieces.push({ str: m[0], x: it.x + charW * m.index, w: charW * m[0].length });
    }
    return pieces;
  }
  // сплошная склейка («40817810550223167389» + «641.00») — режем по границам
  let from = 0;
  for (const b of boundaries) {
    const cut = Math.round((b - it.x) / charW);
    if (cut > from && cut < it.str.length) {
      pieces.push({ str: it.str.slice(from, cut), x: it.x + charW * from, w: charW * (cut - from) });
      from = cut;
    }
  }
  pieces.push({ str: it.str.slice(from), x: it.x + charW * from, w: charW * (it.str.length - from) });
  return pieces;
}

function splitIntoCells(line, columns) {
  const bounds = columns.map((c, i) => [c.x0, i + 1 < columns.length ? columns[i + 1].x0 : Infinity]);
  const cells = columns.map(() => []);
  // колонка с наибольшим перекрытием: числа, выровненные по правому краю,
  // попадают в свою колонку, даже если начинаются левее её границы
  const bestOverlap = (x0, x1) => {
    let best = 0;
    let bestVal = -Infinity;
    for (let c = 0; c < columns.length; c++) {
      const hi = bounds[c][1] === Infinity ? Math.max(x1, bounds[c][0]) + 1 : bounds[c][1];
      const ov = Math.min(x1, hi) - Math.max(x0, bounds[c][0]);
      if (ov > bestVal) { bestVal = ov; best = c; }
    }
    return best;
  };

  for (const it of line) {
    const x1 = it.x + (it.w || 0);
    const col = columns.findIndex((_c, i) => it.x >= bounds[i][0] && it.x < bounds[i][1]);
    const crosses = col >= 0 && x1 > bounds[col][1];
    if (!crosses || WHOLE_NUMBER_RE.test(it.str.trim()) || !it.w || it.str.length < 2) {
      cells[col >= 0 && !crosses ? col : bestOverlap(it.x, x1)].push(it.str);
      continue;
    }
    const inner = bounds.map((b) => b[1]).filter((b) => b > it.x && b < x1);
    for (const piece of splitWideItem(it, inner)) {
      cells[bestOverlap(piece.x, piece.x + piece.w)].push(piece.str);
    }
  }
  return cells.map((parts) => parts.join(" ").replace(/\s+/g, " ").trim());
}

// Карточная авторизация: «...,<сумма>RUR,<город>,MCC <код>,<терминал>\RU\<город>\<МЕРЧАНТ>\»
const CARD_AUTH_RE = /([\d.,]+)\s*(?:RUR|RUB|₽)[^\\]{0,80}?MCC\s*(\d{4})[^\\]{0,40}\\[A-Z]{2}\\[^\\]{0,40}\\([^\\]{2,60})\\/gi;
// Оплата по СБП: «..., <сумма> RUR, <НАЗВАНИЕ ПОЛУЧАТЕЛЯ>, ИНН ...»
const SBP_RE = /([\d.,]+)\s*(?:RUR|RUB|₽)\s*,\s*([^,]{2,60}?)\s*(?:,|$)/gi;

/**
 * Достаёт из назначения платежа название мерчанта и MCC-код.
 * Если в текст попали соседние операции (описание в PDF идёт несколькими
 * строками), нужную выбираем по совпадению суммы внутри текста с суммой операции.
 */
export function extractMerchant(desc, amount) {
  const text = String(desc);
  const pick = (re, mccIdx, nameIdx) => {
    re.lastIndex = 0;
    let m;
    let first = null;
    while ((m = re.exec(text)) !== null) {
      const hit = {
        amount: parseCellNumber(m[1]),
        mcc: mccIdx ? m[mccIdx] : "",
        name: m[nameIdx].trim(),
      };
      if (!first) first = hit;
      if (amount != null && hit.amount != null && Math.abs(hit.amount - amount) < 0.02) return hit;
    }
    return first;
  };
  const card = pick(CARD_AUTH_RE, 2, 3);
  if (card && card.name) return { merchant: card.name, mcc: card.mcc };
  const sbp = pick(SBP_RE, 0, 2);
  if (sbp && sbp.name && /[A-Za-zА-Яа-яЁё]/.test(sbp.name)) {
    const mcc = (text.match(/MCC\s*(\d{4})/i) || [])[1] || "";
    return { merchant: sbp.name, mcc };
  }
  return { merchant: "", mcc: (text.match(/MCC\s*(\d{4})/i) || [])[1] || "" };
}

/**
 * Разбирает страницы PDF как таблицу. Возвращает [] если заголовок таблицы
 * не найден — тогда вызывающий код падает на построчный разбор.
 */
export function transactionsFromPages(pages) {
  const all = [];
  // Заголовок таблицы печатается один раз (обычно на первой странице),
  // а разметка колонок одинакова для всего документа.
  const pageLines = pages.map((items) => (items.length ? groupItemsIntoLines(items) : []));
  let columns = null;
  for (const lines of pageLines) {
    const found = detectColumns(lines);
    if (found) { columns = found.columns; break; }
  }
  if (!columns) return [];
  const idx = {};
  columns.forEach((c, i) => { if (c.role && idx[c.role] === undefined) idx[c.role] = i; });
  if (idx.date === undefined) return [];

  // Куда «течёт» назначение платежа. Если между заголовком таблицы и первой
  // операцией страницы есть строки описания, ячейка выровнена по центру
  // (Совкомбанк) — тогда строку отдаём ближайшей операции. Если таких строк
  // нет, описание идёт вниз от своей операции (Т-Банк) — отдаём наверх.
  const pageData = [];
  let looseAbove = 0;
  for (const lines of pageLines) {
    if (!lines.length) continue;
    const header = detectColumns(lines);
    const headerY = header ? header.headerY : Infinity;
    const rows = [];
    const loose = []; // строки без даты: продолжение назначения платежа
    for (const line of lines) {
      const cells = splitIntoCells(line, columns);
      const dateCell = cells[idx.date] || "";
      const m = DATE_CELL_RE.exec(dateCell);
      const y = line[0].y;
      const descCell = idx.description !== undefined ? cells[idx.description] : "";
      if (m) rows.push({ y, m, cells, desc: descCell ? [descCell] : [] });
      else if (descCell && y < headerY && !PDF_SKIP_RE.test(descCell)) loose.push({ y, text: descCell });
    }
    if (!rows.length) continue;
    const topRowY = Math.max(...rows.map((r) => r.y));
    looseAbove += loose.filter((l) => l.y > topRowY).length;
    pageData.push({ rows, loose });
  }
  const flowsDown = looseAbove === 0;

  for (const { rows, loose } of pageData) {
    for (const l of loose) {
      let best = null;
      let bestD = Infinity;
      for (const r of rows) {
        // описание идёт вниз — годится только операция выше строки
        if (flowsDown && r.y < l.y) continue;
        const dist = Math.abs(r.y - l.y);
        if (dist < bestD) { bestD = dist; best = r; }
      }
      if (best) best.desc.push({ y: l.y, text: l.text });
    }
    for (const r of rows) {
      const parts = r.desc.map((p) => (typeof p === "string" ? { y: r.y, text: p } : p));
      parts.sort((a, b) => b.y - a.y);
      const description = parts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
      const cell = (role) => (idx[role] === undefined ? "" : r.cells[idx[role]]);
      const num = (role) => (idx[role] === undefined ? null : parseCellNumber(cell(role)));
      all.push({
        date: parsePdfDateStr(r.m[1]),
        debit: num("debit"),
        credit: num("credit"),
        amount: num("amount"),
        balance: num("balance"),
        hasDebitCredit: idx.debit !== undefined || idx.credit !== undefined,
        description,
        category: cell("category"),
      });
    }
  }

  // Направление операции: колонки дебет/кредит, иначе знак, иначе остаток.
  const txs = [];
  let prevBalance = null;
  // в выписке проставлены минусы — значит плюс однозначно означает поступление
  const signedAmounts = all.some((r) => r.amount !== null && r.amount < 0);
  for (const r of all) {
    if (!r.date) continue;
    let value = null;
    if (r.hasDebitCredit) {
      if (r.debit) value = Math.abs(r.debit);
    } else if (r.amount !== null && r.amount !== 0) {
      let debit = r.amount < 0 || !signedAmounts;
      if (!signedAmounts && r.balance !== null && prevBalance !== null) {
        const delta = Math.round((r.balance - prevBalance) * 100) / 100;
        if (Math.abs(delta - Math.abs(r.amount)) < 0.02) debit = false;
      }
      if (debit) value = Math.abs(r.amount);
    }
    if (r.balance !== null) prevBalance = r.balance;
    if (!value) continue;
    const found = extractMerchant(r.description, value);
    const cleaned = cleanMerchant(found.merchant || cleanDesc(r.description) || cleanDesc(r.category));
    const desc = cleaned.name;
    const mcc = found.mcc || cleaned.mcc;
    if (!desc) continue;
    txs.push({
      date: r.date,
      amount: value,
      description: desc.slice(0, 200),
      category: r.category.slice(0, 60),
      mcc,
      raw: r.description.slice(0, 200),
    });
  }
  return txs.sort((a, b) => a.date - b.date);
}

export const BRAND_RULES = [
  ["Яндекс Плюс", "Развлечения", "🟡",
    ["YNDX", "YANDEX_PLUS", "YANDEX PLUS", "ЯНДЕКС.ПЛЮС", "ЯНДЕКС ПЛЮС", "ЯНДЕКС+", "YANDEX.MUSIC", "ПЛЮС МУЗЫК", "МУЗЫКА ПЛЮС"]],
  ["Netflix", "Кино и видео", "🎬", ["NETFLIX", "NFLX"]],
  ["Иви", "Кино и видео", "🍿", ["IVI", "ИВИ"]],
  ["Кинопоиск", "Кино и видео", "🎥", ["КИНОПОИСК", "KINOPOISK", "KP*"]],
  ["Okko", "Кино и видео", "🎞️", ["OKKO", "ОККО"]],
  ["KION", "Кино и видео", "🎬", ["KION", "КИОН"]],
  ["Premier", "Кино и видео", "📺", ["PREMIER", "ПРЕМЬЕР"]],
  ["Амедиатека", "Кино и видео", "🍿", ["AMEDIATEKA", "АМЕДИАТЕКА"]],
  ["More.tv", "Кино и видео", "📺", ["MORE.TV", "MORETV", "МОР ТВ"]],
  ["Start", "Кино и видео", "▶️", ["START.RU", "START TV"]],
  ["Wink", "Кино и видео", "📺", ["WINK", "ВИНК"]],
  ["Megogo", "Кино и видео", "🎬", ["MEGOGO", "МЕГОГО"]],
  ["Spotify", "Музыка", "🎧", ["SPOTIFY", "SPOT*"]],
  ["Звук", "Музыка", "🎵", ["ЗВУК", "ZVUK"]],
  ["Apple Music", "Музыка", "🍎", ["APPLE MUSIC", "APPLE.COM/BILLAPPLEMUSIC"]],
  ["VK Музыка", "Музыка", "🎵", ["VK MUZ", "VK MUSIC", "МУЗЫКА VK", "VK.COM/MUSIC", "VK.COM", "SUBSCRIPTION VK"]],
  ["YouTube Premium", "Развлечения", "▶️", ["YOUTUBE", "GOOGLE*YOUTUBE"]],
  ["Telegram Premium", "Мессенджеры", "✈️", ["TG_PREMIUM", "TELEGRAM PREMIUM", "PREMIUMBOT", "T.G PREMIUM", "TEL.EGRAM"]],
  ["WORLD CLASS", "Фитнес", "🏋️", ["WORLD CLASS", "WORLDCLASS", "ФИТНЕС", "WORLD CLUB"]],
  ["СберПрайм", "Экосистема", "🟢", ["СБЕРПРАЙМ", "SBERPRIME", "ПРАЙМ"]],
  ["Яндекс Go", "Транспорт", "🚕", ["YANDEX GO", "ЯНДЕКС ТАКСИ", "ЯНДЕКС ГО", "TAXI"]],
  ["iCloud+", "Облако", "☁️", ["ICLOUD", "APPLE.COM/BILL"]],
  ["Google One", "Облако", "🌐", ["GOOGLE ONE", "GOOGLE ONEAI"]],
  ["Microsoft 365", "ПО", "💻", ["MICROSOFT 365", "MICROSOFT OFFICE", "OFFICE 365"]],
  ["Adobe", "ПО", "🎨", ["ADOBE", "CREATIVE CLOUD"]],
  ["Canva Pro", "Дизайн", "🎨", ["CANVA"]],
  ["Figma", "Дизайн", "🎨", ["FIGMA"]],
  ["Notion", "ПО", "🗂️", ["NOTION"]],
  ["Boosty", "Подписки на авторов", "🚀", ["BOOSTY"]],
  ["Ozon Premium", "Экосистема", "🔵", ["OZON PREMIUM", "ОЗОН ПРЕМИУМ"]],
  ["Литрес", "Книги", "📚", ["LITRES", "ЛИТРЕС"]],
  ["МТС Premium", "Экосистема", "🔴", ["MTS PREMIUM", "МТС ПРЕМИУМ"]],
  ["ChatGPT", "ИИ", "🤖", ["OPENAI", "CHATGPT"]],
  ["Т-Банк Pro", "Банк", "🟡", ["ТБАНК PRO", "TINKOFF PRO", "T-BANK PRO"]],
  ["Обслуживание карты", "Банк", "🏦",
    ["ПЛАТА ЗА ОБСЛУЖИВАНИЕ", "ЗА ОБСЛУЖИВАНИЕ КАРТ", "КОМИССИЯ ЗА ОБСЛУЖИВАНИЕ", "ЕЖЕМЕСЯЧНАЯ ПЛАТА"]],
];

const ABBREV_MAP = { NFLX: "NETFLIX", SPOT: "SPOTIFY", YNDX: "YANDEX" };
const STOP_WORDS = new Set(["RU", "US", "COM", "ORG", "NET", "HTTP", "HTTPS", "WWW", "THE", "AND", "FOR", "LLC", "INC", "LTD", "GMBH"]);

const CANCEL_LINKS = {
  "Яндекс Плюс": "https://plus.yandex.ru",
  Netflix: "https://www.netflix.com/CancelPlan",
  Иви: "https://www.ivi.ru",
  "Telegram Premium": "https://telegram.org",
  Okko: "https://okko.tv",
  "VK Музыка": "https://vk.com",
  "VK Combo": "https://vk.com",
  KION: "https://kion.ru",
  Кинопоиск: "https://kinopoisk.ru",
  Spotify: "https://www.spotify.com",
  "iCloud+": "https://icloud.com",
  "YouTube Premium": "https://www.youtube.com",
  СберПрайм: "https://www.sber.ru",
  "WORLD CLASS": "https://www.worldclass.ru",
  Premier: "https://premier.one",
  Амедиатека: "https://amediateka.ru",
  "More.tv": "https://more.tv",
  Start: "https://start.ru",
  Wink: "https://wink.ru",
  Megogo: "https://megogo.ru",
  "Apple Music": "https://music.apple.com",
  "Apple TV+": "https://tv.apple.com",
  "Google One": "https://one.google.com",
  "Microsoft 365": "https://microsoft.com",
  Adobe: "https://adobe.com",
  Canva: "https://www.canva.com",
  Figma: "https://www.figma.com",
  Notion: "https://www.notion.so",
  Звук: "https://zvuk.com",
};

// Подписки, уже оплаченные в составе других (экосистемных) подписок.
const INCLUDED_IN = {
  Кинопоиск: "Яндекс Плюс",
  Звук: "СберПрайм",
  Okko: "СберПрайм",
  "VK Музыка": "VK Combo",
  "Apple Music": "Apple One",
  "Apple TV+": "Apple One",
};

export function cancelUrl(name) {
  if (CANCEL_LINKS[name]) return CANCEL_LINKS[name];
  return "https://yandex.ru/search/?text=" + encodeURIComponent("как отменить подписку " + name);
}

// Обвязка банка вокруг названия мерчанта: глаголы, город и страна, коды
// терминалов, реквизиты банка. Всё это мешает узнать сервис и склеить его
// разные написания в одну подписку.
const BANK_TAIL_RE = /\s*\d{0,2}\s*в ГУ Банка России.*$|\s*АО\s*«?Т[- ]?Банк»?.*$|\s*универсальная лицензи.*$|\s*СЧЕТ КОРРЕСПОНДЕНТА.*$|\s*Без НДС.*$/i;
const PAY_VERB_RE = /^(?:оплата услуг|оплата в|оплата|платеж|платёж|покупка|списание|перевод в|payment|purchase)\s+/i;
// «YANDEX*5815*PLUS» — между звёздочками MCC-код торговой точки
const STAR_MCC_RE = /\b([A-Z]{2,12})\*(\d{4})\*([A-Z0-9. _-]{2,30})/i;
const WALLET_PREFIX_RE = /\b(?:YM|WB|SBP|QR)\*/gi;
const CITY_TAIL_RE = /\s+[A-Za-zА-Яа-яЁё?'’-]{3,20}\s+(?:RUS|RU|US)\b.*$|\s+(?:RUS|RU|US)\b.*$/i;
const TERMINAL_SUFFIX_RE = /[_.\s]+(?:P[_ ]?QR|QR|SBP|PP[_ ]?CARD|CARD|SHOP|MARKET)\s*$/i;
const PHONE_TAIL_RE = /\s*\+?\d[\d ()-]{8,}\d\s*/g;

/**
 * Приводит описание операции к названию сервиса: убирает «Оплата в», город,
 * страну, коды терминалов и реквизиты банка. Возвращает {name, mcc}.
 */
export function cleanMerchant(desc) {
  let s = String(desc || "").replace(BANK_TAIL_RE, "").trim();
  s = s.replace(PAY_VERB_RE, "");
  let mcc = "";
  const star = STAR_MCC_RE.exec(s);
  if (star) {
    mcc = star[2];
    s = s.replace(STAR_MCC_RE, `$1 $3`);
  }
  s = s.replace(WALLET_PREFIX_RE, "");
  s = s.replace(PHONE_TAIL_RE, " ");
  s = s.replace(CITY_TAIL_RE, "");
  s = s.replace(TERMINAL_SUFFIX_RE, "");
  // ведущий код терминала: «3DI2 FRISBI», «38OP ТС ПЯТЕРОЧКА»
  s = s.replace(/^(?=[A-Z0-9]{2,5}\s)(?=[A-Z0-9]*\d)[A-Z0-9]{2,5}\s+/i, "");
  s = s.replace(/\s+\d{3,6}\s*$/, ""); // номер точки в конце
  s = s.replace(/\s+/g, " ").replace(/^[\s.,·—–-]+|[\s.,·—–-]+$/g, "").trim();
  return { name: s, mcc };
}

// Кириллица → латиница: «ПЯТЕРОЧКА» и «PYATEROCHKA» должны попасть в одну
// группу, иначе один и тот же сервис двоится в отчёте.
const TRANSLIT = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ё: "E", Ж: "ZH", З: "Z", И: "I",
  Й: "I", К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P", Р: "R", С: "S", Т: "T",
  У: "U", Ф: "F", Х: "H", Ц: "TS", Ч: "CH", Ш: "SH", Щ: "SCH", Ъ: "", Ы: "Y",
  Ь: "", Э: "E", Ю: "YU", Я: "YA",
};

export function translit(s) {
  return String(s).toUpperCase().replace(/[А-ЯЁ]/g, (c) => TRANSLIT[c] ?? c);
}

export function normalizeDescription(desc) {
  // транслитерация: «ПЯТЕРОЧКА» и «PYATEROCHKA» — один и тот же магазин
  let s = translit(desc);
  s = s.replace(/HTTPS?:\/\/\S+|WWW\.\S+/g, " ");
  s = s.replace(/\S*\d\S*/g, " ");
  s = s.replace(/[^A-Z ]+/g, " ");
  return s
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t) && t.length > 1)
    .map((t) => ABBREV_MAP[t] ?? t)
    .join(" ");
}

export function canonicalName(description) {
  const s = String(description).toUpperCase();
  for (const [name, cat, icon, keys] of BRAND_RULES) {
    if (keys.some((k) => s.includes(k))) return [name, cat, icon];
  }
  return null;
}

// Сходство названий по Дайсу на биграммах — так «YANDEX PLUS» и «YANDEX
// PLUS RU» считаются одним сервисом, а «KARAVAN» и «NAVARAK» — разными
// (сравнение по множествам символов их путало).
function bigrams(s) {
  const t = translit(s).replace(/[^A-Z0-9]/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function groupKey(description) {
  const canon = canonicalName(description);
  if (canon) return { kind: "brand", value: canon[0] };
  let norm = normalizeDescription(description);
  // пустая нормализация (описание из одних цифр) не склеивает разные транзакции
  if (!norm) norm = "raw:" + String(description).trim().toLowerCase();
  return { kind: "norm", value: norm };
}

const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function addMonths(d, months) {
  const m = d.getMonth() + months; // 0-based, как getMonth()
  const year = d.getFullYear() + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const day = Math.min(d.getDate(), [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month]);
  return new Date(year, month, day);
}

// Кластеризация сумм: у настоящей подписки списания одинаковые. Разовые
// покупки в одном и том же магазине дают россыпь разных сумм — по ним
// подписку не объявляем.
function stableCharges(items, minEvents) {
  const byAmount = [...items].sort((a, b) => a.amount - b.amount);
  const clusters = [];
  for (const t of byAmount) {
    const cur = clusters[clusters.length - 1];
    if (cur) {
      const base = cur[Math.floor(cur.length / 2)].amount;
      if (Math.abs(t.amount - base) <= Math.abs(base) * 0.12) { cur.push(t); continue; }
    }
    clusters.push([t]);
  }
  const newest = items.reduce((a, b) => (a.date > b.date ? a : b));
  // основная цена — самый многочисленный кластер одинаковых списаний
  let main = null;
  for (const c of clusters) {
    if (!main || c.length > main.length ||
        (c.length === main.length && c.includes(newest))) main = c;
  }
  if (!main || main.length < minEvents) return { stable: [], current: 0 };

  const newestCluster = clusters.find((c) => c.includes(newest));
  const span = (c) => [Math.min(...c.map((t) => +t.date)), Math.max(...c.map((t) => +t.date))];
  const [mainFrom, mainTo] = span(main);
  const set = new Set(main);
  // смена цены: уровень идёт до или после основного, не вперемешку с ним
  // (у разовых покупок уровни чередуются во времени — их не берём)
  for (const c of clusters) {
    if (c === main) continue;
    const [from, to] = span(c);
    if (c.includes(newest) || (c.length >= 2 && (to < mainFrom || from > mainTo))) {
      for (const t of c) set.add(t);
    }
  }
  const stable = [...set].sort((a, b) => a.date - b.date);
  const priced = (newestCluster || main).map((t) => Math.abs(t.amount)).sort((a, b) => a - b);
  return { stable, current: priced[Math.floor(priced.length / 2)] };
}

export function detectSubscriptions(txs) {
  const today = new Date();
  // микросписания (< 1 ₽) и нули — обрывки реквизитов, не операции
  txs = txs.filter((t) => Math.abs(t.amount) >= 1);
  const groups = new Map();
  const normKeys = [];
  for (const t of txs) {
    let key = groupKey(t.description);
    if (key.kind === "norm") {
      const merged = normKeys.find((other) => dice(other.value, key.value) >= 0.8);
      if (merged) key = merged;
      else normKeys.push(key);
    }
    const k = key.kind + "|" + key.value;
    if (!groups.has(k)) groups.set(k, { key, items: [] });
    groups.get(k).items.push(t);
  }

  // Слепляем близкие норм-имена к известным брендам.
  for (const nk of normKeys) {
    for (const [name] of BRAND_RULES) {
      const a = translit(nk.value).replace(/[^A-Z0-9]/g, "");
      const b = translit(name).replace(/[^A-Z0-9]/g, "");
      if (b.length >= 4 && (a.includes(b) || (a.length >= 4 && b.includes(a)))) {
        const src = groups.get("norm|" + nk.value);
        const dst = groups.get("brand|" + name);
        if (src && dst) dst.items.push(...src.items);
        groups.delete("norm|" + nk.value);
        break;
      }
    }
  }

  const subs = [];
  for (const { key, items } of groups.values()) {
    // ключ группы транслитерирован, поэтому проверяем ещё и исходные описания
    const sample = key.value + " " +
      [...new Set(items.map((t) => t.description))].slice(0, 4).join(" ");
    // внутренние переводы и вклады — не подписки, даже при регулярности
    if (INTERNAL_RE.test(sample)) continue;
    // платежи ЖКХ и бюджетных учреждений — регулярные, но не подписки
    if (UTILITY_RE.test(sample)) continue;
    // покупки в рознице и по QR — не подписки, даже если повторяются
    if (RETAIL_RE.test(sample)) continue;
    // от описания остался только город или страна — это не название сервиса
    if (CITY_ONLY_RE.test(key.value.trim())) continue;
    // категория из выписки: ЖКХ, супермаркеты, транспорт и т.п. — не подписки
    const catHits = items.filter((t) => t.category && NON_SUB_CATEGORY_RE.test(t.category)).length;
    if (catHits && catHits >= items.length * 0.6) continue;
    // MCC-код торговой точки: продукты, общепит, аптеки, транспорт — не подписки
    const mccHits = items.filter((t) => t.mcc && NON_SUB_MCC.has(t.mcc)).length;
    if (mccHits && mccHits >= items.length * 0.6) continue;
    const minEvents = key.kind === "brand" ? 2 : 3;
    if (items.length < minEvents) continue;
    const { stable, current } = stableCharges(items, minEvents);
    if (stable.length < minEvents) continue;
    // интервалы между списаниями: у подписки они ровные. Частые визиты в
    // магазин дают короткие интервалы — раньше их отбрасывали, и покупки
    // выглядели как ежемесячная подписка.
    const gaps = stable.slice(1).map((t, i) => Math.round((t.date - stable[i].date) / 86400000));
    if (!gaps.length) continue;
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
    const WINDOWS = [
      ["monthly", 20, 40], ["quarterly", 80, 100],
      ["semiannual", 170, 200], ["annual", 330, 400],
    ];
    const win = WINDOWS.find(([, lo, hi]) => medGap >= lo && medGap <= hi);
    if (!win) continue;
    const [period, lo, hi] = win;
    // большинство интервалов должно попадать в тот же ритм
    if (gaps.filter((g) => g >= lo && g <= hi).length < gaps.length * 0.6) continue;

    const MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
    const PERIOD_RU = {
      monthly: "ежемесячно", quarterly: "раз в 3 месяца",
      semiannual: "раз в полгода", annual: "ежегодно",
    };
    const price = Math.abs(current);
    const monthly = price / MONTHS[period];
    const title = key.kind === "brand" ? key.value : key.value.replace(/\w\S*/g, (w) => w[0] + w.slice(1).toLowerCase()) || "Подписка";
    const canon = canonicalName(stable[stable.length - 1].description) || [title, "Прочее", "💳"];
    const name = key.kind === "brand" ? canon[0] : title;
    // имя-обрывок («Qr») — не подписка
    if (name.trim().length < 3) continue;
    const last = stable[stable.length - 1].date;
    // следующее списание: дата в будущем даже если платежи давно прекратились
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let nextDate = addMonths(last, MONTHS[period]);
    while (nextDate < todayMid) {
      nextDate = addMonths(nextDate, MONTHS[period]);
    }
    subs.push({
      id: (title.toLowerCase().replace(/\W+/g, "_").slice(0, 40)) || "sub",
      name,
      category: canon[1],
      icon: canon[2],
      amount: +price.toFixed(2),
      period: PERIOD_RU[period],
      monthly_cost: +monthly.toFixed(2),
      yearly_cost: +(monthly * 12).toFixed(2),
      charges: stable.length,
      // сколько уже отдано этому сервису за период выписки
      total_paid: +stable.reduce((acc, t) => acc + Math.abs(t.amount), 0).toFixed(2),
      // списаний давно нет — подписку, похоже, уже отменили
      active: (todayMid - last) / 86400000 <= MONTHS[period] * 31 * 2,
      first_charge: dateKey(stable[0].date),
      last_charge: dateKey(last),
      next_charge: dateKey(nextDate),
      merchants: [...new Set(stable.map((t) => t.description))].sort(),
      price_change: detectSubscriptionPriceChange(items),
    });
  }
  subs.sort((a, b) => Math.abs(b.monthly_cost) - Math.abs(a.monthly_cost));
  return subs.map((s) => ({
    ...s,
    cancel_url: cancelUrl(s.name),
    included_in: INCLUDED_IN[s.name] ?? null,
  }));
}

const COLUMN_ALIASES = {
  date: ["date", "дата", "дата операции", "дата платежа", "operation date", "transaction date"],
  amount: ["amount", "сумма", "сумма платежа", "сумма операции", "списание", "value"],
  description: ["description", "описание", "наименование", "получатель", "merchant", "назначение", "details", "memo"],
};

function normalizeHeader(h) {
  return String(h)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\(.*?\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\wа-я ]/gi, " ")
    .trim();
}

function pickColumns(headers) {
  const norm = headers.map(normalizeHeader);
  const pick = {};
  // 1) точное совпадение с алиасами
  for (const [kind, aliases] of Object.entries(COLUMN_ALIASES)) {
    const i = norm.findIndex((h) => aliases.includes(h));
    if (i >= 0) pick[kind] = i;
  }
  // 2) вхождение: «сумма» ⊂ «сумма операции», «date» ⊂ «transaction date»
  for (const [kind, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (pick[kind] !== undefined) continue;
    const i = norm.findIndex(
      (h) => h.length >= 3 && aliases.some((a) => h.includes(a) || a.includes(h))
    );
    if (i >= 0) pick[kind] = i;
  }
  return { pick, norm };
}

// Эвристика по содержимому: даты/числа/текст (для нестандартных заголовков).
function guessMissingColumns(rows, headers, pick) {
  const DATE_RE = /\d{1,4}[./-]\d{1,2}[./-]\d{2,4}/;
  const sample = rows.slice(0, 50);
  const stats = [];
  for (let i = 0; i < headers.length; i++) {
    if (Object.values(pick).includes(i)) continue;
    const vals = sample.map((r) => String(r[i] ?? "")).filter((v) => v.trim());
    if (!vals.length) continue;
    const dateN = vals.filter((v) => DATE_RE.test(v)).length;
    let numN = 0;
    for (const v of vals) {
      if (Number.isFinite(parseFloat(v.replace(/[^\d.,-]/g, "").replace(",", ".")))) numN++;
    }
    const textN = vals.reduce((a, v) => a + v.length, 0) / vals.length;
    stats.push({ i, dateN, numN, textN });
  }
  if (pick.date === undefined) {
    const best = stats.filter((s) => s.dateN > 0).sort((a, b) => b.dateN - a.dateN)[0];
    if (best) { pick.date = best.i; }
  }
  if (pick.amount === undefined) {
    const best = stats.filter((s) => s.i !== pick.date && s.numN > 0).sort((a, b) => b.numN - a.numN)[0];
    if (best) { pick.amount = best.i; }
  }
  if (pick.description === undefined) {
    const best = stats.filter((s) => s.i !== pick.date && s.i !== pick.amount)
      .sort((a, b) => b.textN - a.textN)[0];
    if (best) { pick.description = best.i; }
  }
}

function parseDateStr(s) {
  for (const [fmt, re] of [
    ["Y-M-D", /^(\d{4})-(\d{2})-(\d{2})$/],
    ["D.M.Y", /^(\d{2})\.(\d{2})\.(\d{4})$/],
    ["D/M/Y", /^(\d{2})\/(\d{2})\/(\d{4})$/],
    ["D.M.Yy", /^(\d{2})\.(\d{2})\.(\d{2})$/],
  ]) {
    const m = s.trim().match(re);
    if (m) {
      if (fmt === "Y-M-D") return new Date(+m[1], +m[2] - 1, +m[3]);
      const y = fmt === "D.M.Yy" ? 2000 + +m[3] : +m[3];
      return new Date(y, +m[2] - 1, +m[1]);
    }
  }
  return null;
}

function csvSplit(line, delim) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === delim && !inQuotes) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Ищем строку заголовков: выписки Сбера начинаются со служебных строк
// («900 www.sberbank.ru Заказано...», «Выписка по счёту...»), а не с колонок.
function findHeaderRow(lines) {
  let best = { idx: 0, delim: ",", kinds: 0 };
  const limit = Math.min(lines.length, 15);
  for (let i = 0; i < limit; i++) {
    for (const delim of [";", "\t", ","]) {
      const cells = csvSplit(lines[i], delim);
      if (cells.length < 2) continue;
      const norm = cells.map(normalizeHeader);
      let kinds = 0;
      for (const aliases of Object.values(COLUMN_ALIASES)) {
        if (aliases.some((a) => norm.some((n) => n && n.length >= 3 && (a === n || a.includes(n) || n.includes(a))))) kinds++;
      }
      if (kinds > best.kinds) best = { idx: i, delim, kinds };
    }
    if (best.kinds >= 2 && best.idx === i) break; // первая строка, похожая на заголовок
  }
  return best;
}

// CSV: строки -> [{date, amount, description}]
export function parseCsvText(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headerRow = findHeaderRow(lines);
  const headers = csvSplit(lines[headerRow.idx], headerRow.delim);

  // одноколоночный CSV — текстовый дамп выписки (экспорт «как есть»):
  // отдаём все строки построчному PDF-парсеру
  if (headers.length < 2) {
    return transactionsFromLines(
      lines.map((l) => l.replace(/^"|"$/g, "").trim()).filter(Boolean)
    );
  }
  const delim = headerRow.delim;
  const { pick } = pickColumns(headers);
  const rows = lines.slice(headerRow.idx + 1).map((l) => csvSplit(l, delim));
  if (Object.values(pick).some((i) => i === undefined) || Object.keys(pick).length < 3) {
    guessMissingColumns(rows, headers, pick);
  }
  if ([pick.date, pick.amount, pick.description].some((i) => i === undefined)) {
    throw new Error(
      "Не удалось определить в CSV колонки «Дата / Сумма / Описание». Заголовки: " +
      headers.join(", ")
    );
  }
  const txs = [];
  for (const cells of rows) {
    const d = parseDateStr(cells[pick.date] || "");
    const amount = parseFloat(String(cells[pick.amount] ?? "").replace(/[^\d.,-]/g, "").replace(",", "."));
    const desc = String(cells[pick.description] ?? "").trim();
    if (d && !Number.isNaN(amount) && amount !== 0 && desc) {
      txs.push({ date: d, amount, description: desc });
    }
  }
  txs.sort((a, b) => a.date - b.date);
  return txs;
}

export function monthlyExpenseSeries(subs, months = 6) {
  const today = new Date();
  const series = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = addMonths(new Date(today.getFullYear(), today.getMonth(), 1), -i);
    let total = 0;
    for (const s of subs) {
      let cur = new Date(s.first_charge + "T00:00:00");
      for (let guard = 0; guard < 240; guard++) {
        if (cur.getFullYear() > d.getFullYear() ||
            (cur.getFullYear() === d.getFullYear() && cur.getMonth() > d.getMonth())) break;
        if (cur.getMonth() === d.getMonth() && cur.getFullYear() === d.getFullYear()) total += Math.abs(s.monthly_cost);
        cur = addMonths(cur, 1);
      }
    }
    series.push({ month: `${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`, spent: +total.toFixed(2) });
  }
  return series;
}

/** Расходы на подписки по месяцам из фактических списаний (живой график). */
export function monthlyExpenseSeriesFromTxs(txs, subs, months = 6) {
  const today = new Date();
  const merchants = new Map();
  for (const s of subs) for (const m of s.merchants) merchants.set(m, s);
  const series = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = addMonths(new Date(today.getFullYear(), today.getMonth(), 1), -i);
    let total = 0;
    for (const t of txs) {
      const sub = merchants.get(t.description);
      if (!sub) continue;
      if (t.date.getFullYear() === d.getFullYear() && t.date.getMonth() === d.getMonth()) {
        total += Math.abs(t.amount);
      }
    }
    series.push({ month: `${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`, spent: +total.toFixed(2) });
  }
  return series;
}

export function monthlyExpenseSeriesAll(txs, months = 6) {
  const today = new Date();
  const series = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = addMonths(new Date(today.getFullYear(), today.getMonth(), 1), -i);
    let total = 0;
    for (const t of txs) {
      if (t.date.getFullYear() === d.getFullYear() && t.date.getMonth() === d.getMonth()) total += Math.abs(t.amount);
    }
    series.push({ month: `${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`, spent: +total.toFixed(2) });
  }
  return series;
}

// Зарубежные сервисы — им англоязычное письмо. Все остальные (включая
// неизвестные и латинские названия вроде Moscow Rus) — русское письмо.
const FOREIGN_SERVICES = new Set([
  "netflix", "spotify", "apple music", "apple tv+", "icloud+", "icloud",
  "youtube premium", "google one", "microsoft 365", "adobe",
  "canva", "canva pro", "figma", "notion", "telegram premium",
]);

function isRuService(name) {
  return !FOREIGN_SERVICES.has(String(name).trim().toLowerCase());
}

export function buildLetter({ name, amount }) {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dateRu = `${dd}.${mm}.${today.getFullYear()}`;
  if (isRuService(name)) {
    const amountLine = amount
      ? ` в размере ${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} руб./мес`
      : "";
    return `Кому: Служба поддержки «${name}»
Тема: Отказ от автопродления подписки и прекращение списаний

Здравствуйте!

Я, пользователь сервиса «${name}», настоящим уведомляю об отказе от продления
подписки (услуги) с автопродлением${amountLine} и требую прекратить списание
денежных средств с моего банковского счёта.

В соответствии со ст. 32 Закона РФ «О защите прав потребителей» потребитель
вправе отказаться от исполнения договора об оказании услуг в любое время при
оплате фактически понесённых расходов исполнителя. В соответствии со ст. 782
ГК РФ заказчик вправе отказаться от исполнения договора возмездного оказания
услуг при условии оплаты исполнителю фактически понесённых им расходов.

Прошу:
1. Отключить автоматическое продление подписки «${name}».
2. Прекратить дальнейшие списания с моего счёта.
3. Вернуть оплату за неиспользованный период, если списание уже произведено.
4. Подтвердить отключение подписки ответным письмом в течение 10 дней
   (ст. 31 Закона РФ «О защите прав потребителей»).

Дата последнего списания: ${today.toISOString().slice(0, 10)}
Дата обращения: ${dateRu}

С уважением,
Клиент сервиса «${name}»`;
  }
  // Зарубежный сервис: англоязычное письмо без ссылок на законы РФ
  const amountLine = amount
    ? ` (currently ${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} RUB per month)`
    : "";
  return `To: ${name} Support Team
Subject: Request to cancel subscription and stop recurring charges

Hello,

I am a customer of ${name}. I kindly ask you to cancel my subscription and
disable auto-renewal${amountLine}, so that no further charges are made to
my card.

Please:
1. Cancel the subscription and auto-renewal for my account.
2. Stop all further recurring charges.
3. Refund the payment for the unused period, if one has already been charged,
   in accordance with the terms of service.
4. Confirm the cancellation by email.

Date: ${dateRu}

Best regards,
A customer of ${name}`;
}

// Детерминированная тестовая выписка для браузерного режима (без backend).
// ---------------------------------------------------------------------------
// Генератор демо-PDF в браузере: минимальный валидный PDF с текстовыми
// страницами (без зависимостей). Кириллицы нет — демо-описания латиницей.
// ---------------------------------------------------------------------------

const CYR_TO_LAT = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ё: "E", Ж: "Zh", З: "Z",
  И: "I", Й: "Y", К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P", Р: "R",
  С: "S", Т: "T", У: "U", Ф: "F", Х: "Kh", Ц: "Ts", Ч: "Ch", Ш: "Sh",
  Щ: "Shch", Ъ: "", Ы: "Y", Ь: "", Э: "E", Ю: "Yu", Я: "Ya",
};

function toAscii(s) {
  return String(s)
    .split("")
    .map((ch) => CYR_TO_LAT[ch.toUpperCase()] ?? ch)
    .join("")
    .replace(/[^\x20-\x7E]/g, "?");
}

function pdfEscape(s) {
  return toAscii(s).split("\\").join("\\\\").split("(").join("\\(").split(")").join("\\)");
}

// Собирает PDF-байты из готовых страниц (массивы строк {text, bold, size}).
function buildPdf(pages) {
  const objs = []; // строки-объекты, индекс = номер объекта - 1
  const pageObjNums = [];
  const firstPageObj = 5;
  pages.forEach((_, i) => pageObjNums.push(firstPageObj + i * 2));

  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = "<< /Type /Pages /Kids [" + pageObjNums.map((n) => n + " 0 R").join(" ") + "] /Count " + pages.length + " >>";
  objs[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>";
  pages.forEach((pageLines, i) => {
    const pageNum = firstPageObj + i * 2;
    const contentNum = pageNum + 1;
    let stream = "";
    let y = 800;
    for (const line of pageLines) {
      if (line.text !== undefined) {
        const font = line.bold ? "/F2" : "/F1";
        stream += "BT " + font + " " + (line.size || 10) + " Tf 40 " + y + " Td (" + pdfEscape(line.text) + ") Tj ET\n";
      }
      y -= line.size ? Math.max(line.size + 6, 14) : 15;
    }
    objs[pageNum - 1] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
      + "/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " + contentNum + " 0 R >>";
    objs[contentNum - 1] = "<< /Length " + stream.length + " >>\nstream\n" + stream + "endstream";
  });

  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += (i + 1) + " 0 obj\n" + body + "\nendobj\n";
  });
  const xrefStart = out.length;
  out += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
  for (const off of offsets) out += String(off).padStart(10, "0") + " 00000 n \n";
  out += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF";
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** Демо-PDF из текста выписки (CSV): шапка + таблица операций. */
export function makeDemoPdf(csvText) {
  const rows = csvText.split(/\r?\n/).filter((l) => l.trim()).slice(1);
  const pageLines = [];
  const today = new Date();
  pageLines.push({ text: "TEST BANK STATEMENT", bold: true, size: 14 });
  pageLines.push({ text: "Demo document for Subscription Scanner", size: 9 });
  pageLines.push({ text: "Period: " + dateKey(addMonths(today, -6)) + " - " + dateKey(today), size: 9 });
  pageLines.push({ text: "" });
  pageLines.push({ text: "Date          Description                          Amount, RUB", bold: true, size: 10 });
  pageLines.push({ text: "" });
  for (const row of rows) {
    const [d, desc, amt] = row.split(",");
    if (!d || !desc || !amt) continue;
    const dd = d.split("-").reverse().join(".");
    pageLines.push({ text: (dd + "        " + desc.slice(0, 34)).padEnd(44, " ") + " " + amt, size: 9 });
  }
  pageLines.push({ text: "" });
  pageLines.push({ text: "Generated by Subscription Scanner (demo)", size: 8 });
  // разбивка на страницы по ~48 строк
  const pages = [];
  for (let i = 0; i < pageLines.length; i += 48) pages.push(pageLines.slice(i, i + 48));
  return buildPdf(pages);
}

export function testStatementCsv() {
  const today = new Date();
  const base = new Date(today.getFullYear(), today.getMonth() - 6, 5);
  const rows = [["Date", "Description", "Amount"].join(",")];
  // джиттер ±2% — не ломает детекцию (порог цены 5%), но демо всегда новое
  const jitter = (v) => Math.round(v * (1 + (Math.random() * 0.04 - 0.02)) * 100) / 100;

  const pushMonthly = (name, amounts, startOffset = 0) => {
    amounts.forEach((amt, i) => {
      // редкий пропуск месяца, но не больше одного и не для промо/смены цены
      if (amounts.length >= 4 && Math.random() < 0.1 && i > 0 && i < amounts.length - 1) return;
      const d = addMonths(base, i + startOffset);
      const shifted = new Date(d.getFullYear(), d.getMonth(), Math.max(1, Math.min(28, d.getDate() + Math.round(Math.random() * 4 - 2))));
      rows.push(`${dateKey(shifted)},${name},-${jitter(amt).toFixed(2)}`);
    });
  };

  pushMonthly("NETFLIX.COM", [599, 599, 599, 599, 599], 1);    // подключился на 2-м месяце
  pushMonthly("KINOPOISK HD", [399, 399, 399, 399], 2);        // входит в Яндекс Плюс
  pushMonthly("START.RU", [299, 299, 299, 299, 299], 0);       // дубль категории «Кино и видео»
  pushMonthly("YANDEX_PLUS", [399, 399, 399, 399, 399, 399]);
  pushMonthly("ZVUK SUBSCRIPTION", [99, 99, 299, 299], 3);     // промо → полная цена, свежая подписка
  pushMonthly("WORLD CLASS", [3490, 3490, 4990, 4990], 2);     // подняли тариф +43%

  // случайные дополнительные подписки — демо каждый раз разное
  const extras = [
    ["OKKO.SUBSCRIPTION", 449], ["KION.RU", 249], ["VK.COM MUSIC", 299], ["MEGOGO.RU", 199],
  ];
  const extraCount = Math.floor(Math.random() * 3); // 0..2
  const pool = [...extras];
  for (let n = 0; n < extraCount && pool.length; n++) {
    const [name, amt] = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const count = 4 + Math.floor(Math.random() * 2);
    pushMonthly(name, Array(count).fill(amt), Math.floor(Math.random() * 2));
  }

  // шум — случайные покупки, не похожие на бренды
  const noise = [
    ["PYATEROCHKA", 340.5], ["MAGNIT", 890], ["APTEKA", 610.3],
    ["STARBUCKS", 430.7], ["KFC", 398], ["CINEMA PARK", 720],
  ];
  const noiseCount = 3 + Math.floor(Math.random() * 3);
  for (let n = 0; n < noiseCount; n++) {
    const [name, amt] = noise[Math.floor(Math.random() * noise.length)];
    const d = addMonths(base, Math.floor(Math.random() * 5));
    rows.push(`${dateKey(d)},${name},-${jitter(amt).toFixed(2)}`);
  }
  return rows.join("\n");
}
