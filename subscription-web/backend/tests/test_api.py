"""Интеграционные тесты API через fastapi.testclient.TestClient."""

from datetime import date, timedelta

from fastapi.testclient import TestClient

import storage
from main import app
from test_generator import generate_test_csv

client = TestClient(app)


def _monthly_csv(name: str = "NETFLIX.COM 866-579-7172 US", amount: float = 599.0) -> bytes:
    start = date.today() - timedelta(days=200)
    lines = ["Date,Description,Amount"]
    for i in range(6):
        d = start + timedelta(days=30 * i)
        lines.append(f"{d.isoformat()},{name},-{amount:.2f}")
    return "\n".join(lines).encode("utf-8")


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "Сбер.Сканер Подписок"


def test_subscriptions_empty_initially():
    r = client.get("/api/subscriptions")
    assert r.status_code == 200
    body = r.json()
    assert body["subscriptions"] == []
    assert body["mock"] is False


def test_upload_detects_subscription_and_enriches():
    r = client.post("/api/upload", files={"file": ("statement.csv", _monthly_csv(), "text/csv")})
    assert r.status_code == 200
    body = r.json()
    assert len(body["subscriptions"]) == 1
    sub = body["subscriptions"][0]
    assert sub["name"] == "Netflix"
    assert sub["period"] == "ежемесячно"
    assert sub["cancel_url"]  # deep link из services_db
    assert body["total_monthly"] == 599.0


def test_state_survives_server_restart():
    """Анализ хранится в SQLite: новый процесс прочитает то же состояние."""
    client.post("/api/upload", files={"file": ("statement.csv", _monthly_csv(), "text/csv")})
    state = storage.load_state()  # то, что прочитал бы перезапущенный сервер
    assert state is not None
    assert len(state["subscriptions"]) == 1
    assert state["subscriptions"][0]["name"] == "Netflix"


def test_upload_generated_test_csv():
    csv_bytes = generate_test_csv()
    r = client.post("/api/upload", files={"file": ("gen.csv", csv_bytes, "text/csv")})
    assert r.status_code == 200
    body = r.json()
    assert len(body["subscriptions"]) >= 1
    assert body["total_monthly"] > 0


def test_upload_without_subscriptions_shows_real_expenses():
    lines = ["Date,Description,Amount"]
    for d, amt in [(date(2026, 6, 1), 150.33), (date(2026, 6, 15), 900.10),
                   (date(2026, 7, 2), 45.99), (date(2026, 8, 9), 1200.0)]:
        lines.append(f"{d.isoformat()},MAGAZIN MAGNIT,-{amt}")
    r = client.post("/api/upload", files={"file": ("noise.csv", "\n".join(lines).encode(), "text/csv")})
    assert r.status_code == 200
    body = r.json()
    assert body["subscriptions"] == []
    assert body["total_monthly"] == 0
    assert "не найдено" in body["message"]


def test_reset_clears_state():
    client.post("/api/upload", files={"file": ("statement.csv", _monthly_csv(), "text/csv")})
    r = client.post("/api/reset")
    assert r.status_code == 200
    assert r.json() == {"status": "reset"}
    assert storage.load_state() is None
    assert client.get("/api/subscriptions").json()["subscriptions"] == []


def test_upload_rejects_unsupported_format():
    r = client.post("/api/upload", files={"file": ("doc.xlsx", b"fake", "application/octet-stream")})
    assert r.status_code == 422


def test_upload_rejects_empty_file():
    r = client.post("/api/upload", files={"file": ("empty.csv", b"", "text/csv")})
    assert r.status_code == 400


def test_generate_letter():
    # Netflix — зарубежный сервис: англоязычное письмо без законов РФ
    r = client.post("/api/generate-letter", json={"name": "Netflix", "amount": 599.0})
    assert r.status_code == 200
    letter = r.json()["letter"]
    assert "Netflix" in letter
    assert "599.00" in letter
    assert "cancel my subscription" in letter
    assert "782" not in letter


def test_generate_letter_foreign_service_is_english():
    r = client.post("/api/generate-letter", json={"name": "Netflix", "amount": 599.0})
    assert r.status_code == 200
    letter = r.json()["letter"]
    assert "cancel my subscription" in letter
    assert "782" not in letter          # зарубежному сервису законы РФ не пишем
    assert "Защите прав потребителей" not in letter


def test_generate_letter_ru_service_keeps_laws():
    r = client.post("/api/generate-letter", json={"name": "Яндекс Плюс", "amount": 399.0})
    assert r.status_code == 200
    letter = r.json()["letter"]
    assert "782" in letter
    assert "руб./мес" in letter


def test_generate_letter_world_class_is_ru():
    # латинское имя, но российский сервис
    r = client.post("/api/generate-letter", json={"name": "WORLD CLASS"})
    assert r.status_code == 200
    assert "782" in r.json()["letter"]


def test_generate_letter_unknown_latin_defaults_to_ru():
    # по умолчанию — русское письмо: EN только для известных зарубежных брендов
    r = client.post("/api/generate-letter", json={"name": "Steam"})
    assert r.status_code == 200
    assert "782" in r.json()["letter"]


def test_generate_letter_unknown_latin_name_is_ru():
    # «Moscow Rus» — российский магазин с латинским написанием: русское письмо
    r = client.post("/api/generate-letter", json={"name": "Moscow Rus", "amount": 394.0})
    assert r.status_code == 200
    letter = r.json()["letter"]
    assert "782" in letter
    assert "cancel my subscription" not in letter
