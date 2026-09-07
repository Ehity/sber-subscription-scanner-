"""База прямых ссылок на управление/отмену подписок для известных сервисов."""

CANCEL_LINKS = {
    "Яндекс Плюс": "https://plus.yandex.ru",
    "Netflix": "https://www.netflix.com/CancelPlan",
    "Иви": "https://www.ivi.ru",
    "Telegram Premium": "https://telegram.org",
    "Okko": "https://okko.tv",
    "VK Музыка": "https://vk.com",
    "VK Combo": "https://vk.com",
    "KION": "https://kion.ru",
    "Кинопоиск": "https://kinopoisk.ru",
    "Spotify": "https://www.spotify.com",
    "iCloud+": "https://icloud.com",
    "YouTube Premium": "https://www.youtube.com",
    "СберПрайм": "https://www.sber.ru",
    "WORLD CLASS": "https://www.worldclass.ru",
    "Premier": "https://premier.one",
    "Амедиатека": "https://amediateka.ru",
    "More.tv": "https://more.tv",
    "Start": "https://start.ru",
    "Wink": "https://wink.ru",
    "Megogo": "https://megogo.ru",
    "Apple Music": "https://music.apple.com",
    "Apple TV+": "https://tv.apple.com",
    "Google One": "https://one.google.com",
    "Microsoft 365": "https://microsoft.com",
    "Adobe": "https://adobe.com",
    "Canva": "https://www.canva.com",
    "Figma": "https://www.figma.com",
    "Notion": "https://www.notion.so",
    "Звук": "https://zvuk.com",
}

# Часть подписок уже оплачена в составе другой (экосистемной) подписки:
# клиент платит за обе, хотя одной достаточно. Показываем это в карточке.
INCLUDED_IN = {
    "Кинопоиск": "Яндекс Плюс",
    "Звук": "СберПрайм",
    "Okko": "СберПрайм",
    "VK Музыка": "VK Combo",
    "Apple Music": "Apple One",
    "Apple TV+": "Apple One",
}


def get_cancel_url(service_name: str) -> str:
    """Возвращает прямую ссылку на отмену подписки или релевантный поиск."""
    name = (service_name or "").strip()
    if name in CANCEL_LINKS:
        return CANCEL_LINKS[name]
    # Fallback: просто открываем сайт сервиса
    if name:
        return "https://yandex.ru/search/?text=" + name.replace(" ", "+")
    # Название пустое — релевантный общий запрос.
    return "https://yandex.ru/search/?text=как+отменить+подписку"


def enrich_subscriptions(subs: list) -> list:
    """Добавляет каждой подписке cancel_url и included_in (если применимо)."""
    for s in subs:
        s["cancel_url"] = get_cancel_url(s.get("name", ""))
        s["included_in"] = INCLUDED_IN.get(s.get("name", ""))
    return subs
