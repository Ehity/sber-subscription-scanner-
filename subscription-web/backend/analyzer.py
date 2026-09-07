"""Анализ выписки: парсинг CSV, поиск регулярных платежей, нормализация названий."""

from __future__ import annotations

import csv
import io
import random
import re
from datetime import date, datetime, timedelta

# ---------------------------------------------------------------------------
# Нормализация названий: объединяем 'YNDX_PLUS', 'YNDX.MUSIC', 'ЯНДЕКС' в
# одну подписку «Яндекс Плюс» и т.п.
# ---------------------------------------------------------------------------
# (каноничное имя, категория, emoji-иконка, ключевые слова в любом регистре)
BRAND_RULES = [
    # «Яндекс Плюс» — только точечные ключи (общий «ЯНДЕКС» ловит и такси/кино)
    ("Яндекс Плюс", "Развлечения", "🟡",
     ["YNDX", "YANDEX_PLUS", "YANDEX PLUS", "ЯНДЕКС.ПЛЮС", "ЯНДЕКС ПЛЮС",
      "ЯНДЕКС+", "YANDEX.MUSIC", "ПЛЮС МУЗЫК", "МУЗЫКА ПЛЮС"]),
    ("Netflix", "Кино и видео", "🎬",
     ["NETFLIX", "NFLX"]),
    ("Иви", "Кино и видео", "🍿",
     ["IVI", "ИВИ"]),
    ("Кинопоиск", "Кино и видео", "🎥",
     ["КИНОПОИСК", "KINOPOISK", "KP*"]),
    ("Okko", "Кино и видео", "🎞️",
     ["OKKO", "ОККО"]),
    ("KION", "Кино и видео", "🎬",
     ["KION", "КИОН"]),
    ("Premier", "Кино и видео", "📺",
     ["PREMIER", "ПРЕМЬЕР"]),
    ("Амедиатека", "Кино и видео", "🍿",
     ["AMEDIATEKA", "АМЕДИАТЕКА"]),
    ("More.tv", "Кино и видео", "📺",
     ["MORE.TV", "MORETV", "МОР ТВ"]),
    ("Start", "Кино и видео", "▶️",
     ["START.RU", "START TV"]),
    ("Wink", "Кино и видео", "📺",
     ["WINK", "ВИНК"]),
    ("Megogo", "Кино и видео", "🎬",
     ["MEGOGO", "МЕГОГО"]),
    ("Spotify", "Музыка", "🎧",
     ["SPOTIFY", "SPOT*"]),
    ("Звук", "Музыка", "🎵",
     ["ЗВУК", "ZVUK"]),
    ("Apple Music", "Музыка", "🍎",
     ["APPLE MUSIC", "APPLE.COM/BILLAPPLEMUSIC"]),
    ("VK Музыка", "Музыка", "🎵",
     ["VK MUZ", "VK MUSIC", "МУЗЫКА VK", "VK.COM/MUSIC", "VK.COM", "SUBSCRIPTION VK"]),
    ("YouTube Premium", "Развлечения", "▶️",
     ["YOUTUBE", "GOOGLE*YOUTUBE"]),
    ("Telegram Premium", "Мессенджеры", "✈️",
     ["TG_PREMIUM", "TELEGRAM PREMIUM", "PREMIUMBOT", "T.G PREMIUM", "TEL.EGRAM"]),
    ("WORLD CLASS", "Фитнес", "🏋️",
     ["WORLD CLASS", "WORLDCLASS", "ФИТНЕС", "WORLD CLUB"]),
    ("СберПрайм", "Экосистема", "🟢",
     ["СБЕРПРАЙМ", "SBERPRIME", "ПРАЙМ"]),
    ("Яндекс Go", "Транспорт", "🚕",
     ["YANDEX GO", "ЯНДЕКС ТАКСИ", "ЯНДЕКС ГО", "TAXI"]),
    ("iCloud+", "Облако", "☁️",
     ["ICLOUD", "APPLE.COM/BILL"]),
    ("Google One", "Облако", "🌐",
     ["GOOGLE ONE", "GOOGLE ONEAI"]),
    ("Microsoft 365", "ПО", "💻",
     ["MICROSOFT 365", "MICROSOFT OFFICE", "OFFICE 365"]),
    ("Adobe", "ПО", "🎨",
     ["ADOBE", "CREATIVE CLOUD"]),
    ("Canva Pro", "Дизайн", "🎨",
     ["CANVA"]),
    ("Figma", "Дизайн", "🎨",
     ["FIGMA"]),
    ("Notion", "ПО", "🗂️",
     ["NOTION"]),
    ("Boosty", "Подписки на авторов", "🚀", ["BOOSTY"]),
    ("Ozon Premium", "Экосистема", "🔵", ["OZON PREMIUM", "ОЗОН ПРЕМИУМ"]),
    ("Литрес", "Книги", "📚", ["LITRES", "ЛИТРЕС"]),
    ("МТС Premium", "Экосистема", "🔴", ["MTS PREMIUM", "МТС ПРЕМИУМ"]),
    ("ChatGPT", "ИИ", "🤖", ["OPENAI", "CHATGPT"]),
    ("Т-Банк Pro", "Банк", "🟡", ["ТБАНК PRO", "TINKOFF PRO", "T-BANK PRO"]),
    ("Обслуживание карты", "Банк", "🏦",
     ["ПЛАТА ЗА ОБСЛУЖИВАНИЕ", "ЗА ОБСЛУЖИВАНИЕ КАРТ",
      "КОМИССИЯ ЗА ОБСЛУЖИВАНИЕ", "ЕЖЕМЕСЯЧНАЯ ПЛАТА"]),
]


ABBREV_MAP = {"NFLX": "NETFLIX", "SPOT": "SPOTIFY", "YNDX": "YANDEX"}

STOP_WORDS = {"RU", "US", "COM", "ORG", "NET", "HTTP", "HTTPS", "WWW", "THE", "AND", "FOR", "LLC", "INC", "LTD", "GMBH"}



def canonical_name(description: str) -> tuple[str, str, str] | None:
    """Возвращает (название, категория, иконка) или None, если бренд не опознан."""
    s = str(description).upper()
    for name, cat, icon, keys in BRAND_RULES:
        if any(k in s for k in keys):
            return name, cat, icon
    return None


# Обвязка банка вокруг названия мерчанта: глаголы, город и страна, коды
# терминалов, реквизиты банка. Всё это мешает узнать сервис и склеить его
# разные написания в одну подписку.
_BANK_TAIL_RE = re.compile(
    r"\s*\d{0,2}\s*в ГУ Банка России.*$|\s*АО\s*«?Т[- ]?Банк»?.*$|"
    r"\s*универсальная лицензи.*$|\s*СЧЕТ КОРРЕСПОНДЕНТА.*$|\s*Без НДС.*$",
    re.IGNORECASE,
)
_PAY_VERB_RE = re.compile(
    r"^(?:оплата услуг|оплата в|оплата|платеж|платёж|покупка|списание|перевод в|payment|purchase)\s+",
    re.IGNORECASE,
)
# «YANDEX*5815*PLUS» — между звёздочками MCC-код торговой точки
_STAR_MCC_RE = re.compile(r"\b([A-Z]{2,12})\*(\d{4})\*([A-Z0-9. _-]{2,30})", re.IGNORECASE)
_WALLET_PREFIX_RE = re.compile(r"\b(?:YM|WB|SBP|QR)\*", re.IGNORECASE)
_CITY_TAIL_RE = re.compile(
    r"\s+[A-Za-zА-Яа-яЁё?'’-]{3,20}\s+(?:RUS|RU|US)\b.*$|\s+(?:RUS|RU|US)\b.*$",
    re.IGNORECASE,
)
_TERMINAL_SUFFIX_RE = re.compile(
    r"[_.\s]+(?:P[_ ]?QR|QR|SBP|PP[_ ]?CARD|CARD|SHOP|MARKET)\s*$", re.IGNORECASE)
_PHONE_TAIL_RE = re.compile(r"\s*\+?\d[\d ()-]{8,}\d\s*")
_TERMINAL_PREFIX_RE = re.compile(r"^(?=[A-Z0-9]{2,5}\s)(?=[A-Z0-9]*\d)[A-Z0-9]{2,5}\s+", re.IGNORECASE)


def clean_merchant(desc: str) -> tuple[str, str]:
    """Описание операции → (название сервиса, MCC).

    Убирает «Оплата в», город, страну, коды терминалов и реквизиты банка,
    чтобы одинаковые сервисы в разных написаниях попали в одну группу.
    """
    s = _BANK_TAIL_RE.sub("", str(desc or "")).strip()
    s = _PAY_VERB_RE.sub("", s)
    mcc = ""
    star = _STAR_MCC_RE.search(s)
    if star:
        mcc = star.group(2)
        s = _STAR_MCC_RE.sub(r"\1 \3", s)
    s = _WALLET_PREFIX_RE.sub("", s)
    s = _PHONE_TAIL_RE.sub(" ", s)
    s = _CITY_TAIL_RE.sub("", s)
    s = _TERMINAL_SUFFIX_RE.sub("", s)
    s = _TERMINAL_PREFIX_RE.sub("", s)
    s = re.sub(r"\s+\d{3,6}\s*$", "", s)
    s = re.sub(r"\s+", " ", s).strip(" .,·—–-")
    return s, mcc


# Кириллица → латиница: «ПЯТЕРОЧКА» и «PYATEROCHKA» должны попасть в одну
# группу, иначе один и тот же сервис двоится в отчёте.
_TRANSLIT = {
    "А": "A", "Б": "B", "В": "V", "Г": "G", "Д": "D", "Е": "E", "Ё": "E",
    "Ж": "ZH", "З": "Z", "И": "I", "Й": "I", "К": "K", "Л": "L", "М": "M",
    "Н": "N", "О": "O", "П": "P", "Р": "R", "С": "S", "Т": "T", "У": "U",
    "Ф": "F", "Х": "H", "Ц": "TS", "Ч": "CH", "Ш": "SH", "Щ": "SCH",
    "Ъ": "", "Ы": "Y", "Ь": "", "Э": "E", "Ю": "YU", "Я": "YA",
}


def translit(s: str) -> str:
    return "".join(_TRANSLIT.get(c, c) for c in str(s).upper())


def normalize_description(desc: str) -> str:
    # транслитерация: «ПЯТЕРОЧКА» и «PYATEROCHKA» — один и тот же магазин
    s = translit(desc)
    s = re.sub(r"HTTPS?://\S+|WWW\.\S+", " ", s)
    s = re.sub(r"\S*\d\S*", " ", s)            # убираем всё с цифрами
    s = re.sub(r"[^A-Z ]+", " ", s)
    tokens = [
        ABBREV_MAP.get(t, t)
        for t in s.split()
        if t not in STOP_WORDS and len(t) > 1
    ]
    return " ".join(tokens)


def _parse_date(s: str) -> date | None:
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%d.%m.%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


COLUMN_ALIASES = {
    "date": ["date", "дата", "дата операции", "дата платежа", "operation date", "transaction date"],
    "amount": ["amount", "сумма", "сумма платежа", "сумма операции", "списание", "value"],
    "description": ["description", "описание", "наименование", "получатель", "merchant", "назначение", "details", "memo"],
    "category": ["category", "категория", "тип"],
}


def _norm_header(h: str) -> str:
    """Нормализуем заголовок: нижний регистр, без скобок/знаков, ё→е."""
    s = str(h).lower().replace("ё", "е")
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"[^\wа-я ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _pick_columns(rows: list[dict]) -> dict:
    """Ищет колонки: точное совпадение → вхождение → эвристика по данным."""
    headers = list(rows[0])
    norm = {h: _norm_header(h) for h in headers}
    pick: dict[str, str] = {}
    for kind, aliases in COLUMN_ALIASES.items():
        for h in headers:
            if norm[h] in aliases:
                pick[kind] = h
                break
    for kind, aliases in COLUMN_ALIASES.items():
        if kind in pick:
            continue
        for h in headers:
            if len(norm[h]) >= 3 and any(a in norm[h] or norm[h] in a for a in aliases):
                pick[kind] = h
                break

    if not {"date", "amount", "description"}.issubset(pick):
        _guess_columns(rows, headers, pick)
    return pick


_DATE_IN_CELL_RE = re.compile(r"\d{1,4}[./-]\d{1,2}[./-]\d{2,4}")

# Движение денег между своими счетами и наличные — не подписки, даже если
# повторяются регулярно (карта→вклад, переводы СБП, снятие наличных и т.п.)
_INTERNAL_RE = re.compile(
    r"перевод|банкомат|вклад|наличн|пополнен|списание|сбербанк|стипендия"
    r"|kartavklad|vklad|sberbank onl|qr[- ]?код|покупка по qr"
    r"|perevod|popolnen|nalich|vnutrenn|vneshn|raspory"
    r"|тбанк|т-?банк|tbank|универсальн|альфа|alfa|совком|sovcom|втб\b|vtb|райф|raif"
    r"|прочие|prochie|операци",
    re.IGNORECASE,
)

# От описания остался только город или страна — сервиса в нём нет.
_CITY_ONLY_RE = re.compile(
    r"^(?:moscow|moskva|chita|ekaterinburg|sankt|peterburg|piter|novosibirsk|kazan|city|town|rus|ru|us)"
    r"(?:[\s,]+(?:moscow|moskva|chita|ekaterinburg|sankt|peterburg|piter|rus|ru|us))*$",
    re.IGNORECASE,
)

# Платежи ЖКХ и бюджетных учреждений (в т.ч. транслит из СБП-выписок: USLU
# = «услуги», UCHREZD = «учреждение») — регулярные, но это не подписки
_UTILITY_RE = re.compile(
    r"жкх|гис жкх|тсж|квартплат|содержан|жиль[яе]|капремонт|капрем|"
    r"водоканал|водоснабж|водоотвед|теплоснабж|теплосеть|энергосбыт|энергосб[у]|"
    r"газпром|межрегионгаз|горгаз|газserv|газserv|еирц|еркц|расч[её]тн|"
    r"домофон|тко|обращен|вывоз|услуг|услу|uslu|uchrezd|учрежд|жилищ|"
    r"домоуправл|жэу|жэк|жилсервис|госуслуг|штраф|гибдд|налог|пошлин",
    re.IGNORECASE,
)

# Покупки в рознице и по QR (даже регулярные и одинаковые) — не подписки.
# Сюда же — обрывки СБП-описаний с городом (MOSKVA/MOSCOW/Ekaterinburg)
_RETAIL_RE = re.compile(
    r"пятер|pyater|красное[ &-]*белое|krasnoe|магнит|magnit|монетк|monetka|"
    r"fixprice|дикси|dixy|лента|lenta|озон|ozon|wildberries|вайлдберр|"
    r"аптек|apteka|aptech|starbucks|старбакс|kfc|макдоналдс|mcdonalds|"
    r"cinemapark|cinema park|бургер|burger|перекрест|perekrestok|"
    r"вкусно и точка|vkusnoitochka|столовая|кофейн|coffe|coffee|"
    r"пицц|pizza|pitstsa|шаурма|shaurma|продукт|produkt|prodmiks|"
    r"магазин|market|супермаркет|ашан|auchan|вкусвилл|vkusvill|"
    r"светофор|svetofor|додо|dodo|rostics|ростикс|азс|лукойл|роснефть|"
    r"gazprom neft|такси|taxi",
    re.IGNORECASE,
)


def _guess_columns(rows: list[dict], headers: list, pick: dict) -> None:
    """Эвристика для нестандартных заголовков: колонка с датами — «дата»,
    колонка с числами — «сумма», самая длинная текстовая — «описание»."""
    sample = rows[:50]
    stats: list[tuple] = []
    for h in headers:
        if h in pick.values():
            continue
        vals = [str(r.get(h, "")) for r in sample if str(r.get(h, "")).strip()]
        if not vals:
            continue
        date_n = sum(1 for v in vals if _DATE_IN_CELL_RE.search(v))
        num_n = 0
        for v in vals:
            try:
                float(re.sub(r"[^\d.,-]", "", v).replace(",", "."))
                num_n += 1
            except ValueError:
                pass
        text_n = sum(len(v) for v in vals) / len(vals)
        stats.append((h, date_n, num_n, text_n))

    if "date" not in pick:
        best = max((s for s in stats if s[1] > 0), key=lambda s: s[1], default=None)
        if best:
            pick["date"] = best[0]
            stats = [s for s in stats if s[0] != best[0]]
    if "amount" not in pick:
        best = max((s for s in stats if s[0] != pick.get("date") and s[2] > 0),
                   key=lambda s: s[2], default=None)
        if best:
            pick["amount"] = best[0]
            stats = [s for s in stats if s[0] != best[0]]
    if "description" not in pick:
        best = max((s for s in stats if s[0] not in (pick.get("date"), pick.get("amount"))),
                   key=lambda s: s[3], default=None)
        if best:
            pick["description"] = best[0]


def _find_header_line(lines: list[str]) -> int:
    """Выписки Сбера начинаются со служебных строк («900 www.sberbank.ru…»),
    а не с заголовков. Ищем первую строку, где угадываются ≥2 вида колонок."""
    best_idx, best_kinds = 0, 0
    for i, line in enumerate(lines[:15]):
        if not line.strip():
            continue
        for delim in (";", "\t", ","):
            try:
                cells = next(csv.reader([line], delimiter=delim))
            except (csv.Error, StopIteration):
                continue
            if len(cells) < 2:
                continue
            norm = [_norm_header(c) for c in cells]
            kinds = 0
            for aliases in COLUMN_ALIASES.values():
                if any(a in n for n in norm if n for a in aliases):
                    kinds += 1
            if kinds > best_kinds:
                best_idx, best_kinds = i, kinds
        if best_kinds >= 2 and best_idx == i:
            break
    return best_idx


def parse_csv(content: bytes) -> list[dict]:
    """Читает CSV-выписку -> [{'date': date, 'amount': float, 'description': str}]."""
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            text = content.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ValueError("Не удалось определить кодировку файла")

    lines = text.splitlines()
    header_idx = _find_header_line(lines)
    body = "\n".join(lines[header_idx:])

    sample = body[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.DictReader(io.StringIO(body), dialect=dialect))
    if not rows:
        return []

    pick = _pick_columns(rows)
    if not {"date", "amount", "description"}.issubset(pick):
        # CSV с одной колонкой — это текстовый дамп выписки (экспорт «как есть»),
        # прогоняем его через построчный PDF-парсер
        if len(rows[0]) == 1:
            text_lines = [next(iter(r.values())).strip().strip('"') for r in rows]
            return _transactions_from_lines(text_lines)
        raise ValueError(
            "Не удалось определить в CSV колонки «Дата / Сумма / Описание». "
            f"Заголовки: {list(rows[0].keys())}"
        )

    txs = []
    for row in rows:
        d = _parse_date(str(row[pick["date"]]).strip())
        try:
            amount = float(re.sub(r"[^\d.,-]", "", str(row[pick["amount"]])).replace(",", "."))
        except ValueError:
            continue
        desc = str(row[pick["description"]]).strip()
        if amount != 0 and desc and d:
            txs.append({"date": d, "amount": amount, "description": desc})
    txs.sort(key=lambda t: t["date"])
    return txs


# ---------------------------------------------------------------------------
# Парсинг PDF-выписки (формат Сбербанк Онлайн: дата/время → сумма → описание)
# ---------------------------------------------------------------------------
# Строки-заглушки (шапки, итоги, нумерация страниц) — не описания транзакций
_PDF_SKIP_RE = re.compile(
    r"продолжение|страниц|сформирова|справк|выписк|сч[ёе]т\b|доступн|"
    r"баланс|всего|итого|период|владелец|статус|реквизит|валюта|назначение|"
    r"остаток|номер сч|дата откр|дата закрыт|действителен|расшифровк|"
    r"дата операции|описание операц|категория|сумма в валюте",
    re.IGNORECASE,
)
_DATE_RE = re.compile(r"\b(\d{2}[./]\d{2}[./]\d{2,4})\b")
_TIME_ONLY_RE = re.compile(r"^[\d\s:.,+−–—-]+$")
_TIME_IN_DESC_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")

_NBSP = "\u00a0"
_NNBSP = "\u202f"
_SPACES = " " + _NBSP + _NNBSP

# Сумма: необязательный знак, целая часть (с группами по 3) и копейки.
_MONEY_SCAN = re.compile(
    rf"([+\-−–—])?[{_SPACES}]?(\d{{1,3}}(?:[{_SPACES}]\d{{3}})+|\d{{1,9}})"
    rf"(?:([.,])(\d{{1,2}}))?(?:[{_SPACES}]{{0,2}}(₽|руб\.|руб|rub|р\.))?",
    re.IGNORECASE,
)
_GROUP_SEP_RE = re.compile(rf"[{_SPACES}]")


def _mask_non_money(s: str) -> str:
    """Заменяет пробелами то, что похоже на число, но суммой не является.

    Даты, время, маски карт и номера счетов маскируются с сохранением длины
    строки, поэтому позиции найденных сумм остаются валидными.
    """
    def blank(m: re.Match) -> str:
        return " " * len(m.group(0))

    s = re.sub(r"\d{1,2}[./]\d{1,2}[./]\d{2,4}", blank, s)   # 05.03.2026
    s = re.sub(r"\d{1,2}:\d{2}(?::\d{2})?", blank, s)        # 10:04:12
    s = re.sub(r"\*{2,}\s?\d{2,6}", blank, s)                # **** 1234
    s = re.sub(r"\+?\d[\d()-]{9,}\d", blank, s)             # телефоны
    return re.sub(r"\d{10,}", blank, s)                      # номера счетов


def _money_matches(s: str, strict: bool = True) -> list[tuple[str, float, int, int]]:
    """Все суммы в строке: [(знак, значение, начало, конец)].

    `strict` требует явного признака денег (знак, валюта, копейки или
    разделитель тысяч) — иначе код авторизации превращается в миллионы.
    """
    masked = _mask_non_money(s)
    out: list[tuple[str, float, int, int]] = []
    pos = 0
    while pos < len(masked):
        m = _MONEY_SCAN.search(masked, pos)
        if not m:
            break
        sign_raw, whole_raw, _sep, frac_raw, curr_raw = m.groups()
        if not whole_raw:
            pos = m.start() + 1
            continue
        num_start = m.start() + m.group(0).index(whole_raw[0])
        token_start = m.start() + m.group(0).index(sign_raw) if sign_raw else num_start
        prev = masked[token_start - 1] if token_start else ""
        after = masked[m.end():m.end() + 1]
        # число не может продолжать другое число
        if (prev and prev in "0123456789.,:/") or (after and after in "0123456789:/"):
            pos = m.start() + 1
            continue
        grouped = bool(_GROUP_SEP_RE.search(whole_raw))
        whole = _GROUP_SEP_RE.sub("", whole_raw)
        kopecks = bool(frac_raw) and len(frac_raw) == 2
        sign = (sign_raw or "").strip()
        if strict and not (sign or curr_raw or kopecks or grouped):
            pos = m.end() if m.end() > m.start() else m.start() + 1
            continue
        try:
            value = float(whole)
        except ValueError:
            pos = m.start() + 1
            continue
        if frac_raw:
            value += int(frac_raw) / 10 ** len(frac_raw)
        pos = m.end() if m.end() > m.start() else m.start() + 1
        if value >= 100_000_000:  # таких сумм в личной выписке не бывает
            continue
        out.append((sign, round(value, 2), token_start, m.end()))
    return out


def _parse_money(s: str, strict: bool = True) -> tuple[str, float | None]:
    """Возвращает (знак, сумма). Пример: '-599,00 ₽' → ('-', 599.0)."""
    matches = _money_matches(s, strict)
    if not matches:
        return "", None
    sign, value = matches[0][0], matches[0][1]
    return sign, value


_AUTH_CODE_RE = re.compile(r"^\d{4,8}\b\s*")
_OP_BY_CARD_RE = re.compile(r"\s*Операция по карте(?:\s*\*{2,}[\dx]+)?\s*$", re.IGNORECASE)


# MCC-коды торговых точек, где подписок не бывает: продукты, общепит,
# аптеки, АЗС, транспорт, розница, медицина, наличные, ЖКХ.
_NON_SUB_MCC = {
    "4111", "4112", "4121", "4131", "4784", "4789", "3990",          # транспорт
    "4829", "6010", "6011", "6012", "6051",                          # переводы и наличные
    "4900",                                                          # ЖКХ
    "5300", "5310", "5311", "5331", "5399",                          # универмаги
    "5411", "5412", "5422", "5441", "5451", "5462", "5499",          # продукты
    "5541", "5542", "5983",                                          # АЗС
    "5611", "5621", "5641", "5651", "5661", "5691", "5699",          # одежда и обувь
    "5200", "5211", "5231", "5251", "5261", "5712", "5719", "5722", "5732",  # дом
    "5811", "5812", "5813", "5814",                                  # кафе и рестораны
    "5122", "5292", "5295", "5912", "5977", "7230",                  # аптеки, косметика
    "8011", "8021", "8031", "8042", "8043", "8049", "8062", "8071", "8099",  # медицина
}

# Категория операции из выписки Сбера: сюда подписки не попадают.
_NON_SUB_CATEGORY_RE = re.compile(
    r"жкх|коммунальн|супермаркет|продукт|ресторан|кафе|фаст[- ]?фуд|транспорт|"
    r"топлив|азс|такси|аптек|здоровь|красот|одежд|обувь|наличн|перевод|снятие|"
    r"дом и ремонт|вс[её] для дома|автоуслуг|образован|налог|штраф",
    re.IGNORECASE,
)


def _clean_desc(desc: str) -> str:
    """Чистит описание: служебный хвост, даты, время, код авторизации."""
    desc = _OP_BY_CARD_RE.sub("", desc)
    desc = re.sub(r"\d{1,2}[./]\d{1,2}[./]\d{2,4}", " ", desc)
    desc = re.sub(r"\b\d{1,2}:\d{2}(?::\d{2})?\b", " ", desc)
    desc = re.sub(r"\s+", " ", desc).strip()
    desc = _AUTH_CODE_RE.sub("", desc, count=1)
    return desc.strip(" -–−.,\u00a0")


# ---------------------------------------------------------------------------
# Колоночный разбор табличных выписок (Совкомбанк и т.п.)
#
# Построчные регулярки не справляются с таблицей: соседние колонки склеиваются
# («40817810550223167389» + «0.00» → одно число), а назначение платежа лежит
# на отдельных строках выше и ниже строки с датой. Поэтому колонки ищем по
# заголовку таблицы и раскладываем текст по ним геометрически.
# ---------------------------------------------------------------------------

# Роли колонок по тексту заголовка. Порядок важен: сначала точные, потом общие.
_COLUMN_ROLES = [
    ("date", re.compile(r"дата|дат[аы]\s*,?\s*врем", re.I)),
    ("balance", re.compile(r"остаток|баланс|входящ|исходящ", re.I)),
    ("debit", re.compile(r"дебет|расход|списан|уменьшен|снят", re.I)),
    ("credit", re.compile(r"кредит|приход|поступлен|зачислен|увеличен|пополнен", re.I)),
    ("amount", re.compile(r"сумма|amount", re.I)),
    ("category", re.compile(r"категор", re.I)),
    ("description", re.compile(r"назначен|описан|получател|детал|коммент|контрагент|мерчант", re.I)),
    ("account", re.compile(r"^сч[ёе]т", re.I)),
]

def parse_cell_number(text: str) -> float | None:
    """Число из ячейки: «1,000.00», «5 480,00», «641.00» → float."""
    s = re.sub(r"[\s  ₽]|руб\.?|RUB", "", str(text), flags=re.I)
    if not re.fullmatch(r"[+\-−–—]?[\d.,]*\d", s):
        return None
    sign = -1 if s[0] in "-−–—" else 1
    body = s.lstrip("+-−–—")
    last_sep = max(body.rfind("."), body.rfind(","))
    whole, frac = body, ""
    # разделитель считается десятичным, только если после него 1–2 цифры
    if last_sep >= 0 and 1 <= len(body) - last_sep - 1 <= 2:
        whole, frac = body[:last_sep], body[last_sep + 1:]
    whole = whole.replace(".", "").replace(",", "")
    if not whole and not frac:
        return None
    value = int(whole or 0) + (int(frac) / 10 ** len(frac) if frac else 0)
    return sign * round(value, 2)


def _group_items_into_lines(items: list[dict]) -> list[list[dict]]:
    """Элементы страницы -> визуальные строки (по координате Y)."""
    lines: list[list[dict]] = []
    cur: list[dict] = []
    cur_y = None
    for it in sorted(items, key=lambda i: (-i["y"], i["x"])):
        tol = max(2.0, it.get("h", 10) * 0.5)
        if cur_y is not None and abs(it["y"] - cur_y) > tol:
            if cur:
                lines.append(sorted(cur, key=lambda i: i["x"]))
            cur = []
        cur.append(it)
        cur_y = it["y"]
    if cur:
        lines.append(sorted(cur, key=lambda i: i["x"]))
    return lines


_DATE_CELL_RE = re.compile(r"^\s*(\d{2}[./]\d{2}[./]\d{2,4})")
_DATE_TOKEN_RE = re.compile(r"^\d{1,2}[./]\d{1,2}[./]\d{2,4}$")


def _role_of(title: str) -> str | None:
    for role, pattern in _COLUMN_ROLES:
        if pattern.search(title):
            return role
    return None


def _is_data_line(line: list[dict]) -> bool:
    """Строка операции: начинается с даты."""
    return bool(line) and bool(_DATE_TOKEN_RE.match(line[0]["str"].strip()))


def _column_bands(data_lines: list[list[dict]], gutter: float = 2.0) -> list[list[float]]:
    """Полосы колонок по вертикальным просветам в строках операций.

    Заголовок для этого не годится: в одних выписках слова заголовка одной
    колонки разделены пробелами («Дата и время операции»), в других соседние
    колонки стоят вплотную («Дата,время» и «Счет»). Данные выровнены всегда.
    """
    spans = sorted(
        (it["x"], it["x"] + it.get("w", 0)) for line in data_lines for it in line
    )
    if not spans:
        return []
    bands = [[spans[0][0], spans[0][1]]]
    for a, b in spans[1:]:
        if a - bands[-1][1] < gutter:
            bands[-1][1] = max(bands[-1][1], b)
        else:
            bands.append([a, b])
    return bands


def _build_columns(header_words, data_lines, header_line) -> list[dict]:
    """Полосы данных + роли из слов заголовка."""
    bands = _column_bands(data_lines)
    if len(bands) < 2:
        bands = _column_bands([header_line], 10.0)

    titles: list[list[dict]] = [[] for _ in bands]
    for w in header_words:
        best, best_val = -1, float("-inf")
        for i, band in enumerate(bands):
            ov = min(w["x"] + w.get("w", 0), band[1]) - max(w["x"], band[0])
            if ov > best_val:
                best, best_val = i, ov
        if best >= 0:
            titles[best].append(w)

    # полоса без слов заголовка — хвост соседней колонки (описание переносится
    # по строкам и рвёт полосу на куски), приклеиваем её влево
    merged: list[dict] = []
    for band, ws in zip(bands, titles):
        if ws or not merged:
            merged.append({"band": list(band), "words": ws})
        else:
            merged[-1]["band"][1] = band[1]
    while len(merged) > 1 and not merged[0]["words"]:
        merged[1]["band"][0] = merged[0]["band"][0]
        merged.pop(0)

    columns: list[dict] = []
    for m in merged:
        words = sorted(m["words"], key=lambda w: (w["x"], -w["y"]))
        # в одной полосе могут стоять заголовки нескольких колонок, если между
        # ними нет просвета («Счет» / «Входящий остаток» / «Дебет»). Новую
        # колонку начинает слово, чья роль отличается от роли текущей группы;
        # слова одного заголовка стоят вплотную, поэтому нужен и отступ.
        groups: list[dict] = []
        for w in words:
            r = _role_of(w["str"])
            cur = groups[-1] if groups else None
            if cur is None or (r and cur["role"] and r != cur["role"] and w["x"] - cur["x"] >= 20):
                groups.append({"x": w["x"], "role": r, "words": [w]})
            else:
                cur["words"].append(w)
                if not cur["role"]:
                    cur["role"] = r
        if not groups:
            columns.append({"x0": m["band"][0], "x1": m["band"][1], "title": "", "role": None})
            continue
        for i, g in enumerate(groups):
            x0 = m["band"][0] if i == 0 else g["x"]
            x1 = groups[i + 1]["x"] if i + 1 < len(groups) else m["band"][1]
            title = " ".join(w["str"] for w in sorted(g["words"], key=lambda w: (-w["y"], w["x"])))
            columns.append({"x0": x0, "x1": x1, "title": title, "role": _role_of(title)})
    return sorted(columns, key=lambda c: c["x0"])


def _detect_columns(lines: list[list[dict]]) -> list[dict] | None:
    """Ищет строку-заголовок таблицы и возвращает колонки [{x0, title, role}]."""
    data_lines = [l for l in lines if _is_data_line(l)]
    for i, line in enumerate(lines):
        if _is_data_line(line):
            continue
        roles = {r for r in (_role_of(it["str"]) for it in line) if r}
        if len(roles) < 2 or not roles & {"debit", "credit", "amount", "balance"}:
            continue
        # шапка бывает в две-три строки («Дата и время» / «операции»)
        header_words = list(line)
        hy, hh = line[0]["y"], line[0].get("h", 10)
        for j in (i - 2, i - 1, i + 1, i + 2):
            if j < 0 or j >= len(lines):
                continue
            ln = lines[j]
            if _is_data_line(ln) or abs(ln[0]["y"] - hy) > hh * 2.6:
                continue
            if any(re.search(r"\d", it["str"]) for it in ln):
                continue
            header_words.extend(ln)

        columns = _build_columns(header_words, data_lines, line)
        found = {c["role"] for c in columns if c["role"]}
        if len(found) >= 2 and "date" in found:
            # низ шапки: вторая строка заголовка не должна попасть в описание
            header_y = min(w["y"] for w in header_words)
            for c in columns:
                c["header_y"] = header_y
            return columns
    return None


# Одно аккуратное число: «39 000,00», «1,000.00», «-599,00». Такой текст
# колонкам не принадлежит частично — его нельзя резать по границе.
_WHOLE_NUMBER_RE = re.compile(rf"^[+\-−–—]?\d{{1,3}}(?:[{_SPACES},.]\d{{3}})*(?:[.,]\d{{1,2}})?$")


def _split_wide_item(it: dict, boundaries: list[float]) -> list[dict]:
    """Делит фрагмент, накрывший несколько колонок, на части с оценкой координат.

    Ширина символа берётся средней по фрагменту — этого достаточно, чтобы
    отнести каждую часть к своей колонке.
    """
    text = it["str"]
    char_w = it.get("w", 0) / max(1, len(text))
    pieces = []
    if re.search(r"\s", text.strip()):
        # есть пробелы — режем по словам, так точнее всего
        for m in re.finditer(r"\S+", text):
            pieces.append({"str": m.group(0), "x": it["x"] + char_w * m.start(),
                           "w": char_w * len(m.group(0))})
        return pieces
    # сплошная склейка («40817810550223167389» + «641.00») — режем по границам
    frm = 0
    for b in boundaries:
        cut = round((b - it["x"]) / char_w) if char_w else 0
        if frm < cut < len(text):
            pieces.append({"str": text[frm:cut], "x": it["x"] + char_w * frm,
                           "w": char_w * (cut - frm)})
            frm = cut
    pieces.append({"str": text[frm:], "x": it["x"] + char_w * frm,
                   "w": char_w * (len(text) - frm)})
    return pieces


def _split_into_cells(line: list[dict], columns: list[dict]) -> list[str]:
    """Раскладывает элементы строки по колонкам таблицы."""
    bounds = [
        (c["x0"], columns[i + 1]["x0"] if i + 1 < len(columns) else float("inf"))
        for i, c in enumerate(columns)
    ]
    cells: list[list[str]] = [[] for _ in columns]

    def best_overlap(x0: float, x1: float) -> int:
        """Колонка с наибольшим перекрытием: числа, выровненные по правому краю,
        попадают в свою колонку, даже если начинаются левее её границы."""
        best, best_val = 0, float("-inf")
        for c, (lo, hi) in enumerate(bounds):
            top = max(x1, lo) + 1 if hi == float("inf") else hi
            ov = min(x1, top) - max(x0, lo)
            if ov > best_val:
                best, best_val = c, ov
        return best

    for it in line:
        x1 = it["x"] + it.get("w", 0)
        col = next((i for i, (lo, hi) in enumerate(bounds) if lo <= it["x"] < hi), -1)
        crosses = col >= 0 and x1 > bounds[col][1]
        if not crosses or _WHOLE_NUMBER_RE.match(it["str"].strip()) \
                or not it.get("w") or len(it["str"]) < 2:
            cells[col if (col >= 0 and not crosses) else best_overlap(it["x"], x1)].append(it["str"])
            continue
        inner = [hi for _lo, hi in bounds if it["x"] < hi < x1]
        for piece in _split_wide_item(it, inner):
            cells[best_overlap(piece["x"], piece["x"] + piece["w"])].append(piece["str"])
    return [re.sub(r"\s+", " ", " ".join(parts)).strip() for parts in cells]


# Карточная авторизация: «...,<сумма>RUR,<город>,MCC <код>,<терминал>\RU\<город>\<МЕРЧАНТ>\»
_CARD_AUTH_RE = re.compile(
    r"([\d.,]+)\s*(?:RUR|RUB|₽)[^\\]{0,80}?MCC\s*(\d{4})[^\\]{0,40}\\[A-Z]{2}\\[^\\]{0,40}\\([^\\]{2,60})\\",
    re.I,
)
# Оплата по СБП: «..., <сумма> RUR, <НАЗВАНИЕ ПОЛУЧАТЕЛЯ>, ИНН ...»
_SBP_RE = re.compile(r"([\d.,]+)\s*(?:RUR|RUB|₽)\s*,\s*([^,]{2,60}?)\s*(?:,|$)", re.I)
_MCC_RE = re.compile(r"MCC\s*(\d{4})", re.I)


def extract_merchant(desc: str, amount: float | None) -> tuple[str, str]:
    """Название мерчанта и MCC-код из назначения платежа.

    Если в текст попали соседние операции (назначение в PDF занимает
    несколько строк), нужную выбираем по совпадению суммы внутри текста.
    """
    text = str(desc)

    def pick(pattern, name_group):
        first = None
        for m in pattern.finditer(text):
            hit = (parse_cell_number(m.group(1)), m.group(name_group).strip())
            if first is None:
                first = hit
            if amount is not None and hit[0] is not None and abs(hit[0] - amount) < 0.02:
                return hit
        return first

    card = pick(_CARD_AUTH_RE, 3)
    if card and card[1]:
        mcc_m = _CARD_AUTH_RE.search(text)
        return card[1], (mcc_m.group(2) if mcc_m else "")
    sbp = pick(_SBP_RE, 2)
    mcc = (_MCC_RE.search(text).group(1) if _MCC_RE.search(text) else "")
    if sbp and sbp[1] and re.search(r"[A-Za-zА-Яа-яЁё]", sbp[1]):
        return sbp[1], mcc
    return "", mcc


def _transactions_from_pages(pages: list[list[dict]]) -> list[dict]:
    """Разбирает страницы как таблицу. [] — если заголовок таблицы не найден."""
    page_lines = [_group_items_into_lines(items) for items in pages]
    columns = None
    for lines in page_lines:
        if lines:
            columns = _detect_columns(lines)
            if columns:
                break
    if not columns:
        return []
    idx: dict[str, int] = {}
    for i, c in enumerate(columns):
        if c["role"] and c["role"] not in idx:
            idx[c["role"]] = i
    if "date" not in idx:
        return []

    # Куда «течёт» назначение платежа. Если между заголовком таблицы и первой
    # операцией страницы есть строки описания, ячейка выровнена по центру
    # (Совкомбанк) — строку отдаём ближайшей операции. Если таких строк нет,
    # описание идёт вниз от своей операции (Т-Банк) — отдаём наверх.
    page_data, loose_above = [], 0
    for lines in page_lines:
        if not lines:
            continue
        header = _detect_columns(lines)
        header_y = header[0]["header_y"] if header else float("inf")
        rows, loose = [], []
        for line in lines:
            cells = _split_into_cells(line, columns)
            m = _DATE_CELL_RE.match(cells[idx["date"]] or "")
            desc_cell = cells[idx["description"]] if "description" in idx else ""
            y = line[0]["y"]
            if m:
                rows.append({"y": y, "m": m, "cells": cells,
                             "desc": [(y, desc_cell)] if desc_cell else []})
            elif desc_cell and y < header_y and not _PDF_SKIP_RE.search(desc_cell):
                loose.append((y, desc_cell))
        if not rows:
            continue
        top_row_y = max(r["y"] for r in rows)
        loose_above += sum(1 for y, _t in loose if y > top_row_y)
        page_data.append((rows, loose))
    flows_down = loose_above == 0

    records = []
    for rows, loose in page_data:
        for y, text in loose:
            # описание идёт вниз — годится только операция выше строки
            candidates = [r for r in rows if not flows_down or r["y"] >= y]
            if not candidates:
                continue
            min(candidates, key=lambda r: abs(r["y"] - y))["desc"].append((y, text))
        for r in rows:
            description = re.sub(
                r"\s+", " ",
                " ".join(t for _y, t in sorted(r["desc"], key=lambda p: -p[0])),
            ).strip()
            cell = lambda role: (r["cells"][idx[role]] if role in idx else "")  # noqa: E731
            num = lambda role: (parse_cell_number(cell(role)) if role in idx else None)  # noqa: E731
            records.append({
                "date": _parse_date(r["m"].group(1)),
                "debit": num("debit"),
                "credit": num("credit"),
                "amount": num("amount"),
                "balance": num("balance"),
                "has_debit_credit": "debit" in idx or "credit" in idx,
                "description": description,
                "category": cell("category"),
            })

    # Направление операции: колонки дебет/кредит, иначе знак, иначе остаток.
    txs: list[dict] = []
    prev_balance = None
    # в выписке проставлены минусы — значит плюс однозначно означает поступление
    signed_amounts = any(r["amount"] is not None and r["amount"] < 0 for r in records)
    for r in records:
        if not r["date"]:
            continue
        value = None
        if r["has_debit_credit"]:
            if r["debit"]:
                value = abs(r["debit"])
        elif r["amount"]:
            debit = r["amount"] < 0 or not signed_amounts
            if not signed_amounts and r["balance"] is not None and prev_balance is not None:
                delta = round(r["balance"] - prev_balance, 2)
                if abs(delta - abs(r["amount"])) < 0.02:
                    debit = False
            if debit:
                value = abs(r["amount"])
        if r["balance"] is not None:
            prev_balance = r["balance"]
        if not value:
            continue
        merchant, mcc = extract_merchant(r["description"], value)
        raw = merchant or _clean_desc(r["description"]) or _clean_desc(r["category"])
        desc, cleaned_mcc = clean_merchant(raw)
        if not desc:
            continue
        txs.append({"date": r["date"], "amount": value, "description": desc[:200],
                    "category": r["category"][:60], "mcc": mcc or cleaned_mcc})
    return sorted(txs, key=lambda t: t["date"])


def parse_pdf(content: bytes) -> list[dict]:
    """Транзакции из текстового PDF-выписки.

    Сначала пробуем колоночный разбор (табличные выписки Совкомбанка и др.),
    затем — построчный (Сбербанк Онлайн и простые макеты).
    """
    import io as _io

    import pdfplumber

    pages: list[list[dict]] = []
    lines: list[str] = []
    with pdfplumber.open(_io.BytesIO(content)) as pdf:
        for page in pdf.pages:
            pages.append([
                {"str": w["text"], "x": w["x0"], "y": page.height - w["bottom"],
                 "w": w["x1"] - w["x0"], "h": w["bottom"] - w["top"]}
                for w in page.extract_words(x_tolerance=1.5)
            ])
            text = page.extract_text() or ""
            lines.extend(l.strip() for l in text.splitlines() if l.strip())

    txs = _transactions_from_pages(pages)
    return txs if txs else _transactions_from_lines(lines)


def _pick_amount(moneys: list[tuple[str, float, int, int]]):
    """Сумма операции vs остаток по счёту.

    Остаток стоит в строке последним и всегда без знака, поэтому:
      - если есть суммы со знаком — операция это последняя из них;
      - иначе при двух и более числах последнее считаем остатком.
    """
    if not moneys:
        return None
    signed = [m for m in moneys if m[0]]
    if signed:
        return signed[-1]
    if len(moneys) >= 2:
        return moneys[-2]
    return moneys[0]


def _is_debit_sign(sign: str) -> bool:
    return bool(sign) and sign in "−–—-"


def _line_text(line: str, moneys: list[tuple[str, float, int, int]]) -> str:
    """Текст строки без найденных сумм (и без дат/времени)."""
    out = []
    pos = 0
    for _sign, _value, start, end in moneys:
        out.append(line[pos:start])
        pos = end
    out.append(line[pos:])
    return _clean_desc(" ".join(out))


def _transactions_from_lines(lines: list[str]) -> list[dict]:
    """Собирает операции из строк PDF-выписки.

    Поддерживает форматы:
      1) многострочный (Сбер):  '05.08.26 17:04' / '−599,00 ₽' / 'NETFLIX.COM ...'
      2) однострочный:          '05.08.2026  NETFLIX.COM  -599,00 ₽'
      3) реальная выписка СберБанк Онлайн: 'дата | категория | сумма | остаток',
         а мерчант, время и код авторизации — следующей строкой
    """
    rows = [l.rstrip() for l in lines if l and l.strip()]

    records: list[dict] = []
    cur: dict | None = None

    def flush() -> None:
        nonlocal cur
        if cur and cur["amount"] is not None:
            records.append(cur)
        cur = None

    for line in rows:
        is_skip = bool(_PDF_SKIP_RE.search(line))
        m_date = _DATE_RE.search(line)
        moneys = _money_matches(line)
        text = _line_text(line, moneys)

        if m_date and not is_skip:
            d = _parse_date(m_date.group(1))
            if d:
                flush()
                chosen = _pick_amount(moneys)
                cur = {
                    "date": d,
                    "amount": chosen[1] if chosen else None,
                    "sign": chosen[0] if chosen else "",
                    "balance": moneys[-1][1] if len(moneys) >= 2 else None,
                    "category": text if text and not _TIME_ONLY_RE.fullmatch(text) else "",
                    "desc": [],
                }
                continue

        if cur is None:
            continue

        if moneys and cur["amount"] is None:
            chosen = _pick_amount(moneys)
            cur["amount"] = chosen[1]
            cur["sign"] = chosen[0]
            if len(moneys) >= 2:
                cur["balance"] = moneys[-1][1]
        if text and not is_skip and not _TIME_ONLY_RE.fullmatch(text):
            cur["desc"].append(text)

    flush()

    # Направление операции: по знаку, иначе — по изменению остатка по счёту.
    txs: list[dict] = []
    prev_balance: float | None = None
    for r in records:
        debit = True
        if r["sign"]:
            debit = _is_debit_sign(r["sign"])
        elif r["balance"] is not None and prev_balance is not None:
            delta = round(r["balance"] - prev_balance, 2)
            if abs(delta + r["amount"]) < 0.02:
                debit = True
            elif abs(delta - r["amount"]) < 0.02:
                debit = False
        if r["balance"] is not None:
            prev_balance = r["balance"]
        if not debit or not r["amount"]:
            continue
        # описание: мерчант со строк-продолжений важнее названия категории
        merchant = _clean_desc(" ".join(r["desc"]))
        raw = merchant or r["category"]
        if not raw:
            continue
        description, mcc = clean_merchant(raw)
        if not description:
            continue
        txs.append({
            "date": r["date"],
            "amount": r["amount"],
            "description": description[:120],
            "category": (r["category"] if merchant else "")[:60],
            "mcc": mcc,
        })

    return sorted(txs, key=lambda t: t["date"])


def _add_months(d: date, months: int) -> date:
    m = d.month - 1 + months
    year = d.year + m // 12
    month = m % 12 + 1
    day = min(d.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
                      31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return date(year, month, day)


def _bigrams(s: str) -> set[str]:
    t = re.sub(r"[^A-Z0-9]", "", translit(s))
    return {t[i:i + 2] for i in range(len(t) - 1)}


def _dice(a: str, b: str) -> float:
    """Сходство названий по Дайсу на биграммах.

    Так «YANDEX PLUS» и «YANDEX PLUS RU» — один сервис, а «KARAVAN» и
    «NAVARAK» — разные (сравнение по множествам символов их путало).
    """
    A, B = _bigrams(a), _bigrams(b)
    if not A or not B:
        return 0.0
    return 2 * len(A & B) / (len(A) + len(B))

def _canonical_group_key(desc: str) -> tuple:
    """Ключ группы: известный бренд либо нормализованное имя.
    Пустая нормализация (описание из одних цифр) не склеивает разные
    транзакции — ключом становится сырая строка."""
    canon = canonical_name(desc)
    if canon:
        return ("brand", canon[0])
    norm = normalize_description(desc)
    if not norm:
        norm = "raw:" + str(desc).strip().lower()
    return ("norm", norm)


_PRICE_TOLERANCE = 0.05  # допуск, при котором цена считается той же

# Ритм списаний: (период, минимальный интервал, максимальный интервал в днях)
_PERIOD_WINDOWS = [
    ("monthly", 20, 40), ("quarterly", 80, 100),
    ("semiannual", 170, 200), ("annual", 330, 400),
]
_PERIOD_MONTHS = {"monthly": 1, "quarterly": 3, "semiannual": 6, "annual": 12}
_PERIOD_RU = {"monthly": "ежемесячно", "quarterly": "раз в 3 месяца",
              "semiannual": "раз в полгода", "annual": "ежегодно"}


def _stable_charges(items: list[dict], min_events: int = 2) -> tuple[list[dict], float]:
    """Отбирает списания со стабильной ценой: (списания, актуальная цена).

    У настоящей подписки списания одинаковые. Разовые покупки в одном и том
    же магазине дают россыпь разных сумм — по ним подписку не объявляем.
    Основная цена — самый многочисленный кластер; если последнее списание
    прошло по другой цене, оно тоже учитывается (цена выросла).
    """
    by_amount = sorted(items, key=lambda t: t["amount"])
    clusters: list[list[dict]] = []
    for t in by_amount:
        if clusters:
            base = clusters[-1][len(clusters[-1]) // 2]["amount"]
            if abs(t["amount"] - base) <= abs(base) * 0.12:
                clusters[-1].append(t)
                continue
        clusters.append([t])

    newest = max(items, key=lambda t: t["date"])
    main: list[dict] | None = None
    for c in clusters:
        if main is None or len(c) > len(main) or (len(c) == len(main) and newest in c):
            main = c
    if not main or len(main) < min_events:
        return [], 0.0

    newest_cluster = next((c for c in clusters if newest in c), None)

    def span(c):
        return min(t["date"] for t in c), max(t["date"] for t in c)

    main_from, main_to = span(main)
    chosen = list(main)
    # смена цены: уровень идёт до или после основного, не вперемешку с ним
    # (у разовых покупок уровни чередуются во времени — их не берём)
    for c in clusters:
        if c is main:
            continue
        c_from, c_to = span(c)
        if (newest in c) or (len(c) >= 2 and (c_to < main_from or c_from > main_to)):
            chosen += [t for t in c if t not in chosen]
    chosen.sort(key=lambda t: t["date"])
    priced = sorted(abs(t["amount"]) for t in (newest_cluster or main))
    return chosen, priced[len(priced) // 2]

def detect_price_change(items: list[dict]) -> dict:
    """Одно подтверждённое изменение цены за историю подписки.

    Смена считается реальной, если на каждом ценовом уровне минимум 2
    списания с допуском ±5% — одиночный «странный» платёж не считается.
    Формат полей совпадает с JS-версией (frontend/src/lib/subscriptionPriceChange.js).
    """
    payments = sorted(
        ({"date": t["date"], "amount": abs(float(t["amount"]))} for t in items),
        key=lambda p: p["date"],
    )
    if len(payments) < 4:
        return {"hasChange": False}

    def same_price(a: float, b: float) -> bool:
        avg = (a + b) / 2
        return avg > 0 and abs(a - b) / avg <= _PRICE_TOLERANCE

    def median(vals: list[float]) -> float:
        s = sorted(vals)
        mid = len(s) // 2
        return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2

    def trailing_level(idx: int) -> tuple[int, float, int]:
        amounts = [payments[idx]["amount"]]
        i = idx - 1
        while i >= 0 and same_price(payments[i]["amount"], median(amounts)):
            amounts.append(payments[i]["amount"])
            i -= 1
        return idx - len(amounts) + 1, median(amounts), len(amounts)

    new_start, new_price, new_count = trailing_level(len(payments) - 1)
    if new_count < 2 or new_start == 0:
        return {"hasChange": False}
    _, old_price, old_count = trailing_level(new_start - 1)
    if old_count < 2 or same_price(old_price, new_price):
        return {"hasChange": False}
    difference = round(new_price - old_price, 2)
    percent = round(difference / old_price * 100, 2)
    if abs(percent) < _PRICE_TOLERANCE * 100:
        return {"hasChange": False}
    return {
        "hasChange": True,
        "direction": "up" if difference > 0 else "down",
        "oldPrice": round(old_price, 2),
        "newPrice": round(new_price, 2),
        "difference": difference,
        "percentChange": percent,
        "changedAt": payments[new_start]["date"].isoformat(),
    }


def detect_subscriptions(txs: list[dict]) -> list[dict]:
    # микросписания (< 1 ₽) и нули — обрывки реквизитов, не операции
    txs = [t for t in txs if abs(t["amount"]) >= 1]
    groups: dict[tuple, list[dict]] = {}
    norm_keys: list[tuple] = []
    for t in txs:
        key = _canonical_group_key(t["description"])
        if key[0] == "norm":
            # эвристика: слепляем близкие нормализованные имена (YNDX_PLUS vs YANDEX PLUS)
            merged = None
            for other in norm_keys:
                if _dice(other[1], key[1]) >= 0.8:
                    merged = other
                    break
            if merged is not None:
                key = merged
            else:
                norm_keys.append(key)
        groups.setdefault(key, []).append(t)

    # Небольшой «glue» между группами: если норм-имя очень близко к бренду — слить бренд
    for norm_key in list(norm_keys):
        for brand_name, _cat, _icons, _keys in BRAND_RULES:
            a = re.sub(r"[^A-Z0-9]", "", translit(norm_key[1]))
            b = re.sub(r"[^A-Z0-9]", "", translit(brand_name))
            if len(b) >= 4 and (b in a or (len(a) >= 4 and a in b)):
                groups.setdefault(("brand", brand_name), []).extend(groups.pop(norm_key, []))
                break

    subs = []
    for key, items in groups.items():
        # ключ группы транслитерирован, поэтому проверяем и сами описания
        seen: list[str] = []
        for t in items:
            if t["description"] not in seen:
                seen.append(t["description"])
        sample = str(key[1]) + " " + " ".join(seen[:4])
        # внутренние переводы и вклады — не подписки, даже при регулярности
        if _INTERNAL_RE.search(sample):
            continue
        # платежи ЖКХ и бюджетных учреждений — регулярные, но не подписки
        if _UTILITY_RE.search(sample):
            continue
        # покупки в рознице и по QR — не подписки, даже если повторяются
        if _RETAIL_RE.search(sample):
            continue
        # от описания остался только город или страна — это не название сервиса
        if _CITY_ONLY_RE.match(str(key[1]).strip()):
            continue
        # категория из выписки: ЖКХ, супермаркеты, транспорт и т.п. — не подписки
        cat_hits = sum(
            1 for t in items
            if t.get("category") and _NON_SUB_CATEGORY_RE.search(t["category"])
        )
        if cat_hits and cat_hits >= len(items) * 0.6:
            continue
        # MCC-код торговой точки: продукты, общепит, аптеки, транспорт — не подписки
        mcc_hits = sum(1 for t in items if t.get("mcc") in _NON_SUB_MCC)
        if mcc_hits and mcc_hits >= len(items) * 0.6:
            continue
        min_events = 2 if key[0] == "brand" else 3  # брендовые сервисы достаточны уже с 2 списаниями
        if len(items) < min_events:  # минимум списаний, чтобы отличать подписку от случайных совпадений
            continue
        stable, price = _stable_charges(items, min_events)
        if len(stable) < min_events:
            continue
        stable.sort(key=lambda t: t["date"])
        # интервалы между списаниями: у подписки они ровные. Частые визиты в
        # магазин дают короткие интервалы — раньше их отбрасывали, и покупки
        # выглядели как ежемесячная подписка.
        gaps = [(stable[i + 1]["date"] - stable[i]["date"]).days
                for i in range(len(stable) - 1)]
        if not gaps:
            continue
        med_gap = sorted(gaps)[len(gaps) // 2]
        window = next((w for w in _PERIOD_WINDOWS if w[1] <= med_gap <= w[2]), None)
        if not window:
            continue
        period, lo, hi = window
        # большинство интервалов должно попадать в тот же ритм
        if sum(1 for g in gaps if lo <= g <= hi) < len(gaps) * 0.6:
            continue

        last = stable[-1]["date"]
        price = abs(price)
        monthly = price / _PERIOD_MONTHS[period]
        title = key[1] if key[0] == "brand" else key[1].title() or "Подписка"
        name, cat, icon = canonical_name(stable[-1]["description"]) or (title, "Прочее", "💳")
        # имя-обрывок («Qr») — не подписка
        if len(name.strip()) < 3:
            continue
        # следующее списание: дата в будущем даже если платежи давно прекратились
        step = _PERIOD_MONTHS[period]
        next_date = _add_months(last, step)
        while next_date < date.today():
            next_date = _add_months(next_date, step)
        subs.append({
            "id": re.sub(r"\W+", "_", title.lower())[:40] or "sub",
            "name": name if key[0] == "brand" else title,
            "category": cat,
            "icon": icon,
            "amount": round(price, 2),
            "period": _PERIOD_RU[period],
            "monthly_cost": round(monthly, 2),
            "yearly_cost": round(monthly * 12, 2),
            "charges": len(stable),
            # сколько уже отдано этому сервису за период выписки
            "total_paid": round(sum(abs(t["amount"]) for t in stable), 2),
            # списаний давно нет — подписку, похоже, уже отменили
            "active": (date.today() - last).days <= _PERIOD_MONTHS[period] * 31 * 2,
            "first_charge": stable[0]["date"].isoformat(),
            "last_charge": last.isoformat(),
            "next_charge": next_date.isoformat(),
            "merchants": sorted({t["description"] for t in stable}),
            "price_change": detect_price_change(items),
        })
    subs.sort(key=lambda s: -abs(s["monthly_cost"]))
    return subs


def monthly_expense_series(subs: list[dict], months: int = 6) -> list[dict]:
    """Расходы на подписки по месяцам (для графика)."""
    today = date.today()
    series = []
    for i in range(months - 1, -1, -1):
        d = _add_months(today.replace(day=1), -i)
        total = 0.0
        for s in subs:
            cur = date.fromisoformat(s["first_charge"])
            for _ in range(240):
                if (cur.year, cur.month) > (d.year, d.month):
                    break
                if cur.month == d.month and cur.year == d.year:
                    total += abs(s["monthly_cost"])
                cur = _add_months(cur, 1)
        series.append({"month": d.strftime("%m.%Y"), "spent": round(total, 2)})
    return series


def monthly_expense_series_from_txs(txs: list[dict], subs: list[dict], months: int = 6) -> list[dict]:
    """Расходы на подписки по месяцам из ФАКТИЧЕСКИХ списаний.

    В отличие от monthly_expense_series (ровная модель регулярных платежей),
    здесь видны пропуски месяцев и смены цены — график живой, как в выписке.
    """
    today = date.today()
    merchants: dict[str, dict] = {}
    for s in subs:
        for m in s.get("merchants", []):
            merchants[m] = s
    series = []
    for i in range(months - 1, -1, -1):
        d = _add_months(today.replace(day=1), -i)
        total = 0.0
        for t in txs:
            sub = merchants.get(t["description"])
            if sub is None:
                continue
            if t["date"].year == d.year and t["date"].month == d.month:
                total += abs(t["amount"])
        series.append({"month": d.strftime("%m.%Y"), "spent": round(total, 2)})
    return series


def monthly_expense_series_all(txs: list[dict], months: int = 6) -> list[dict]:
    """Реальные списания по месяцам из ВСЕХ транзакций (не только подписки).

    Строит график общих расходов по выписке, когда подписок не найдено.
    """
    today = date.today()
    series = []
    for i in range(months - 1, -1, -1):
        d = _add_months(today.replace(day=1), -i)
        total = 0.0
        for t in txs:
            td = t["date"]
            if td.year == d.year and td.month == d.month:
                total += t["amount"]
        series.append({"month": d.strftime("%m.%Y"), "spent": round(total, 2)})
    return series


# ---------------------------------------------------------------------------
# Демо-данные (fallback, чтобы UI всегда был готов к презентации)
# ---------------------------------------------------------------------------
def demo_payload() -> dict:
    today = date.today()
    rng = random.Random()

    # Слегка варьируем суммы подписок (±10%), чтобы экономия была разной
    subs = [
        _demo_sub("world_class", "WORLD CLASS", "Фитнес", "🏋️", round(3490.0 * rng.uniform(0.9, 1.1), -1), today, -7, 23),
        _demo_sub("netflix", "Netflix", "Кино и видео", "🎬", round(599.0 * rng.uniform(0.9, 1.1), -1), today, -7, 23),
        _demo_sub("yandex_plus", "Яндекс Плюс", "Развлечения", "🟡", round(399.0 * rng.uniform(0.9, 1.1), -1), today, -7, 23),
        _demo_sub("ivi", "Иви", "Кино и видео", "🍿", round(299.0 * rng.uniform(0.9, 1.1), -1), today, -7, 23),
        _demo_sub("icloud", "iCloud+", "Облако", "☁️", round(149.0 * rng.uniform(0.9, 1.1), -1), today, -7, 23),
    ]
    total_monthly = round(sum(s["monthly_cost"] for s in subs), 2)

    # Волнистый график: каждый месяц ±15-30% от базовой суммы
    base = total_monthly
    series = []
    for i in range(5, -1, -1):
        d = _add_months(today.replace(day=1), -i)
        jitter = round(base * rng.uniform(0.7, 1.3), 2)
        series.append({"month": d.strftime("%m.%Y"), "spent": jitter})

    return {
        "mock": True,
        "subscriptions": subs,
        "monthly": series,
        "total_monthly": total_monthly,
        "total_yearly": round(total_monthly * 12, 2),
        "message": "Показаны демонстрационные данные — загрузите CSV-выписку для анализа своей",
    }


def _demo_sub(sid, name, category, icon, amount, today, last_shift, next_shift):
    first_charge = _add_months(today, -5)
    return {
        "id": sid, "name": name, "category": category, "icon": icon,
        "amount": amount, "period": "ежемесячно",
        "monthly_cost": amount, "yearly_cost": round(amount * 12, 2),
        "charges": 6,
        "first_charge": first_charge.isoformat(),
        "last_charge": (today + timedelta(days=last_shift)).isoformat(),
        "next_charge": (today + timedelta(days=next_shift)).isoformat(),
        "merchants": [],
    }
