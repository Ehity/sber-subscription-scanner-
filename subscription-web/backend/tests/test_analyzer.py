"""Юнит-тесты анализатора: парсинг CSV/PDF-строк, нормализация брендов, детекция подписок."""

from datetime import date, timedelta

import pytest

from analyzer import (
    _parse_money,
    _transactions_from_lines,
    canonical_name,
    detect_subscriptions,
    normalize_description,
    parse_csv,
)


# --------------------------------------------------------------------------
# Вспомогательные конструкторы
# --------------------------------------------------------------------------

def make_txs(n: int, amount: float, start: date, step_days: int, desc: str) -> list[dict]:
    return [
        {"date": start + timedelta(days=step_days * i), "amount": -abs(amount), "description": desc}
        for i in range(n)
    ]


# --------------------------------------------------------------------------
# parse_csv
# --------------------------------------------------------------------------

def test_parse_csv_comma_utf8():
    rows = ["Date,Description,Amount"]
    for i in range(3):
        rows.append(f"2026-07-0{i + 1},NETFLIX.COM,-599.00")
    txs = parse_csv("\n".join(rows).encode("utf-8"))
    assert len(txs) == 3
    assert txs[0] == {"date": date(2026, 7, 1), "amount": -599.0, "description": "NETFLIX.COM"}


def test_parse_csv_semicolon_cp1251_russian_headers():
    rows = ["Дата операции;Сумма;Описание", "01.07.2026;-599,00;ЯНДЕКС.ПЛЮС"]
    txs = parse_csv("\n".join(rows).encode("cp1251"))
    assert len(txs) == 1
    assert txs[0]["description"] == "ЯНДЕКС.ПЛЮС"
    assert txs[0]["amount"] == -599.0


def test_parse_csv_missing_columns_raises():
    with pytest.raises(ValueError):
        parse_csv(b"foo,bar\n1,2")


def test_parse_csv_fuzzy_headers():
    # «Дата и время», «Сумма (руб)», «Назначение платежа» — не точные алиасы
    rows = ["Дата и время;Сумма (руб);Назначение платежа",
            "01.07.2026;-599,00;ЯНДЕКС.ПЛЮС"]
    txs = parse_csv("\n".join(rows).encode("cp1251"))
    assert len(txs) == 1
    assert txs[0]["description"] == "ЯНДЕКС.ПЛЮС"
    assert txs[0]["amount"] == -599.0


def test_parse_csv_positional_guess():
    # вообще нестандартные заголовки — колонки угадываются по содержимому
    rows = ["Col1,Col2,Col3",
            "2026-07-01,NETFLIX.COM,-599.00",
            "2026-07-02,NETFLIX.COM,-599.00"]
    txs = parse_csv("\n".join(rows).encode("utf-8"))
    assert len(txs) == 2
    assert txs[0]["description"] == "NETFLIX.COM"
    assert txs[0]["amount"] == -599.0


def test_parse_csv_skips_rows_without_date():
    rows = ["Date,Description,Amount", "2026-07-01,NETFLIX,-599.00", ",NETFLIX,-599.00"]
    txs = parse_csv("\n".join(rows).encode("utf-8"))
    assert len(txs) == 1


# --------------------------------------------------------------------------
# Нормализация брендов
# --------------------------------------------------------------------------

@pytest.mark.parametrize("desc,expected", [
    ("YNDX_PLUS PAYMENT", "Яндекс Плюс"),
    ("NFLX* 8NQ4R2", "Netflix"),
    ("ОККО ПОДПИСКА", "Okko"),
    ("ICLOUD+ 50GB", "iCloud+"),
    ("WORLD CLASS FITNES", "WORLD CLASS"),
    ("TG_PREMIUM", "Telegram Premium"),
])
def test_canonical_name_known_brands(desc, expected):
    assert canonical_name(desc)[0] == expected


def test_canonical_name_unknown_returns_none():
    assert canonical_name("PYATEROCHKA 2451") is None


def test_normalize_description_drops_noise_tokens():
    # домен/телефон/стоп-слова исчезают, остаётся чистое имя бренда
    assert normalize_description("NETFLIX.COM 866-579-7172 US") == "NETFLIX"


# --------------------------------------------------------------------------
# _parse_money (PDF-суммы)
# --------------------------------------------------------------------------

def test_parse_money_strict_signed():
    assert _parse_money("-599,00 ₽", True) == ("-", 599.0)
    assert _parse_money("+1 200,00 руб.", True) == ("+", 1200.0)


def test_parse_money_strict_accepts_currency():
    # строгий режим: валюта — достаточный признак суммы
    assert _parse_money("599.0 RUB", True) == ("", 599.0)


def test_parse_money_loose_unsigned_with_currency():
    assert _parse_money("599.0 RUB", False) == ("", 599.0)


def test_parse_money_loose_rejects_phone():
    assert _parse_money("866-579-7172", False) == ("", None)


# --------------------------------------------------------------------------
# _transactions_from_lines (PDF-выписка)
# --------------------------------------------------------------------------

def test_pdf_lines_multiline_sber_format():
    lines = [
        "05.08.26 17:04",
        "−599,00 ₽",
        "NETFLIX.COM 866-579-7172 US",
        "Баланс на конец периода 50 000,00 ₽",  # шум: не должен стать транзакцией
    ]
    txs = _transactions_from_lines(lines)
    # мерчант чистится: телефон и страна убираются чистильщиком описаний
    assert len(txs) == 1
    assert txs[0]["date"] == date(2026, 8, 5)
    assert txs[0]["amount"] == 599.0
    assert txs[0]["description"].startswith("NETFLIX.COM")


def test_pdf_lines_single_line_format():
    lines = ["05.08.2026  NETFLIX.COM  -599,00 ₽"]
    txs = _transactions_from_lines(lines)
    assert len(txs) == 1
    assert txs[0]["amount"] == 599.0
    assert txs[0]["description"] == "NETFLIX.COM"


def test_pdf_lines_credit_lines_ignored_when_debits_present():
    lines = [
        "05.08.26 10:00", "−599,00 ₽", "NETFLIX.COM",
        "06.08.26 10:00", "+1000,00 ₽", "PEREVOD OT DRUGA",
    ]
    txs = _transactions_from_lines(lines)
    assert len(txs) == 1
    assert txs[0]["description"] == "NETFLIX.COM"


# --------------------------------------------------------------------------
# detect_subscriptions
# --------------------------------------------------------------------------

def test_detect_monthly_brand_subscription():
    txs = make_txs(6, 599.0, date(2026, 1, 5), 30, "NETFLIX.COM 866-579-7172 US")
    subs = detect_subscriptions(txs)
    assert len(subs) == 1
    s = subs[0]
    assert s["name"] == "Netflix"
    assert s["period"] == "ежемесячно"
    assert s["charges"] == 6
    assert s["amount"] == 599.0
    assert s["monthly_cost"] == 599.0
    assert s["yearly_cost"] == 7188.0


def test_detect_annual_subscription():
    txs = make_txs(3, 269.0, date(2024, 3, 1), 365, "SPOT* MUSIC")
    subs = detect_subscriptions(txs)
    assert len(subs) == 1
    s = subs[0]
    assert s["period"] == "ежегодно"
    assert s["amount"] == 269.0
    assert s["monthly_cost"] == round(269.0 / 12, 2)


def test_detect_unknown_merchant_needs_three_charges():
    # неизвестный мерчант — подписка определяется с 3 списаний, категория «Прочее»
    txs = make_txs(3, 450.0, date(2026, 1, 10), 30, "FITNESS CLUB XYZ")
    subs = detect_subscriptions(txs)
    assert len(subs) == 1
    assert subs[0]["category"] == "Прочее"
    assert subs[0]["period"] == "ежемесячно"


def test_detect_rejects_unstable_amounts():
    amounts = [-100.0, -500.0, -900.0, -1300.0, -1700.0]
    txs = [
        {"date": date(2026, 1, 5) + timedelta(days=30 * i), "amount": a, "description": "NETFLIX.COM"}
        for i, a in enumerate(amounts)
    ]
    assert detect_subscriptions(txs) == []


def test_detect_rejects_weekly_charges():
    txs = make_txs(8, 299.0, date(2026, 1, 5), 7, "NETFLIX.COM")
    assert detect_subscriptions(txs) == []


def test_detect_rejects_single_charge():
    txs = make_txs(1, 599.0, date(2026, 1, 5), 30, "NETFLIX.COM")
    assert detect_subscriptions(txs) == []


def test_detect_merges_merchant_spellings():
    # разные написания одного бренда попадают в одну подписку
    descs = ["YNDX_PLUS", "Yandex Plus", "ЯНДЕКС.ПЛЮС"]
    txs = []
    for i in range(6):
        txs.append({"date": date(2026, 1, 7) + timedelta(days=30 * i),
                    "amount": -399.0, "description": descs[i % len(descs)]})
    subs = detect_subscriptions(txs)
    assert len(subs) == 1
    assert subs[0]["name"] == "Яндекс Плюс"
    assert subs[0]["charges"] == 6


def test_detect_price_change_promo_to_full():
    # смена цены: первые месяцы промо 99 ₽, дальше полные 299 ₽ —
    # подписка детектируется целиком, актуальная цена = 299
    txs = []
    for i in range(5):
        txs.append({"date": date(2026, 1, 5) + timedelta(days=30 * i),
                    "amount": -99.0 if i < 2 else -299.0,
                    "description": "SPOT* MUSIC"})
    subs = detect_subscriptions(txs)
    assert len(subs) == 1
    s = subs[0]
    assert s["name"] == "Spotify"
    assert s["charges"] == 5
    assert s["amount"] == 299.0
    assert s["monthly_cost"] == 299.0
    assert s["yearly_cost"] == 3588.0


def test_detect_price_change_reported_positive():
    # стоимости подписок положительные (фронтенд суммирует их в «экономию»)
    txs = make_txs(4, 450.0, date(2026, 1, 10), 30, "FITNESS CLUB XYZ")
    subs = detect_subscriptions(txs)
    assert len(subs) == 1
    assert subs[0]["monthly_cost"] > 0
    assert subs[0]["yearly_cost"] > 0


def test_price_change_detected_on_tariff_raise():
    # 3 списания по 299, затем 2 по 399 — подтверждённое повышение тарифа
    txs = [
        {"date": date(2026, 1, 5) + timedelta(days=30 * i),
         "amount": -(299.0 if i < 3 else 399.0),
         "description": "YANDEX_PLUS"}
        for i in range(5)
    ]
    subs = detect_subscriptions(txs)
    assert len(subs) == 1
    pc = subs[0]["price_change"]
    assert pc["hasChange"] is True
    assert pc["direction"] == "up"
    assert pc["oldPrice"] == 299.0
    assert pc["newPrice"] == 399.0
    assert pc["percentChange"] == 33.44


def test_price_change_absent_for_flat_subscription():
    txs = make_txs(5, 599.0, date(2026, 1, 5), 30, "NETFLIX.COM")
    subs = detect_subscriptions(txs)
    assert subs[0]["price_change"]["hasChange"] is False


def test_price_change_ignores_single_odd_payment():
    # один «странный» платёж среди стабильных — не смена тарифа
    amounts = [599.0, 599.0, 899.0, 599.0, 599.0]
    txs = [
        {"date": date(2026, 1, 5) + timedelta(days=30 * i),
         "amount": -a, "description": "NETFLIX.COM"}
        for i, a in enumerate(amounts)
    ]
    subs = detect_subscriptions(txs)
    assert subs[0]["price_change"]["hasChange"] is False


def test_utility_payments_not_subscriptions():
    # ЖКХ-платежи (СБП-идентификаторы с транслитом «услуги»): регулярные,
    # но подписками быть не должны
    txs = []
    for i in range(4):
        txs.append({"date": date(2026, 1, 5) + timedelta(days=30 * i),
                    "amount": -6409.78,
                    "description": "302328101501100603936,754.46 4900,941612\RU\Yekaterinburg\3DI2 FRISBI USLU*FRISB\\"})
    txs.append({"date": date(2026, 5, 5), "amount": -500, "description": "ГИС ЖКХ КВАРТПЛАТА"})
    subs = detect_subscriptions(txs)
    assert subs == []


def test_real_subscriptions_survive_utility_filter():
    txs = [
        {"date": date(2026, 1, 5) + timedelta(days=30 * i), "amount": -599.0,
         "description": "NETFLIX.COM 866-579-7172 US"}
        for i in range(5)
    ]
    subs = detect_subscriptions(txs)
    assert len(subs) == 1
    assert subs[0]["name"] == "Netflix"


def test_retail_purchases_not_subscriptions():
    # регулярные покупки в рознице и по QR — не подписки (кейс с телефона)
    txs = []
    for i in range(9):
        txs.append({"date": date(2026, i % 12 + 1, 12), "amount": -94.0,
                    "description": "KRASNOE BELOE Qr"})
    for i in range(11):
        txs.append({"date": date(2026, i % 12 + 1, 21), "amount": -65.0,
                    "description": "ПЯТЕРOCHKA"})  # смешанные алфавиты
    for i in range(5):
        txs.append({"date": date(2026, i + 1, 8), "amount": -394.0,
                    "description": "Moscow Rus"})
    # настоящая подписка среди розницы должна выжить
    for i in range(5):
        txs.append({"date": date(2026, i + 1, 5), "amount": -599.0,
                    "description": "NETFLIX.COM"})
    subs = detect_subscriptions(txs)
    assert [s["name"] for s in subs] == ["Netflix"]


def test_next_charge_always_in_future():
    # подписка перестала списываться год назад — next_charge всё равно в будущем
    txs = [{"date": date(2025, 3, 5) + timedelta(days=30 * i), "amount": -599.0,
            "description": "NETFLIX.COM"} for i in range(5)]
    subs = detect_subscriptions(txs)
    assert subs[0]["next_charge"] >= date.today().isoformat()


def test_bank_transfers_and_qr_not_subscriptions():
    # переводы в другой банк и покупки по QR (кейс с телефона) — не подписки
    txs = []
    for i in range(8):
        txs.append({"date": date(2026, i + 1, 16), "amount": -440.0,
                    "description": "АО ТБАНК УНИВЕРСАЛЬНЫЙ КЛАССИЧЕСКИЙ"})
    for i in range(9):
        txs.append({"date": date(2026, i + 1, 18), "amount": -150.0,
                    "description": "Покупка по QR-коду №019dde39"})
    for i in range(5):
        txs.append({"date": date(2026, i + 1, 5), "amount": -599.0,
                    "description": "NETFLIX.COM"})
    subs = detect_subscriptions(txs)
    assert [s["name"] for s in subs] == ["Netflix"]
