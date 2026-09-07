"""Тесты services_db: дип-линки отмены и карта «входит в другую подписку»."""

from services_db import CANCEL_LINKS, INCLUDED_IN, enrich_subscriptions, get_cancel_url


def test_fixed_cancel_links():
    assert get_cancel_url("Яндекс Плюс") == "https://plus.yandex.ru"
    assert get_cancel_url("Netflix") == "https://www.netflix.com/CancelPlan"
    assert get_cancel_url("Google One") == "https://one.google.com"
    assert get_cancel_url("СберПрайм") == "https://www.sber.ru"
    assert get_cancel_url("Звук") == "https://zvuk.com"


def test_cancel_link_fallback_for_unknown():
    url = get_cancel_url("Какой-то сервис")
    assert "yandex.ru/search" in url


def test_included_in_mapping_present():
    subs = [{"name": "Кинопоиск"}, {"name": "Звук"}, {"name": "Okko"}]
    enrich_subscriptions(subs)
    by_name = {s["name"]: s for s in subs}
    assert by_name["Кинопоиск"]["included_in"] == "Яндекс Плюс"
    assert by_name["Звук"]["included_in"] == "СберПрайм"
    assert by_name["Okko"]["included_in"] == "СберПрайм"
    # ссылки не сломаны
    assert by_name["Кинопоиск"]["cancel_url"] == "https://kinopoisk.ru"


def test_included_in_absent_for_standalone():
    subs = [{"name": "Netflix"}]
    enrich_subscriptions(subs)
    assert subs[0]["included_in"] is None


def test_no_link_points_to_dead_page():
    # Яндекс Плюс на yandex.ru/plus отдавал 404 — такой URL не должен вернуться
    assert "yandex.ru/plus" not in CANCEL_LINKS.values()
    # каждая ссылка — https
    for url in CANCEL_LINKS.values():
        assert url.startswith("https://")
