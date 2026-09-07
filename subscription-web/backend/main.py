"""Сбер.Сканер Подписок — FastAPI backend.

Эндпоинты:
    GET  /api/health           — статус
    GET  /api/subscriptions    — анализ или демо-данные (fallback mock)
    POST /api/upload           — загрузка CSV-выписки, анализ
    POST /api/generate-letter  — текст заявления на отмену автопродления
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from analyzer import (
    demo_payload,
    detect_subscriptions,
    monthly_expense_series_all,
    monthly_expense_series_from_txs,
    parse_csv,
    parse_pdf,
)
from services_db import enrich_subscriptions
from storage import clear_state, load_state, save_state
from test_generator import generate_test_csv, generate_test_pdf, generate_test_with_data

app = FastAPI(title="Сбер.Сканер Подписок API", version="1.0.0")

# Раздача собранного фронтенда (frontend/dist), если он собран
_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # для хакатонного MVP
    allow_methods=["*"],
    allow_headers=["*"],
)

# Результат последнего анализа хранится в SQLite (scanner.db, см. storage.py)
# и переживает перезапуск сервера.


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "Сбер.Сканер Подписок", "today": date.today().isoformat()}


@app.get("/api/subscriptions")
def get_subscriptions() -> dict:
    """Анализ загруженной выписки; если её нет — пустое состояние (Empty State)."""
    state = load_state()
    if state is not None:
        return state
    # Нет загруженной выписки — возвращаем Empty State (БЕЗ demo_payload).
    return {
        "mock": False,
        "subscriptions": [],
        "monthly": [],
        "total_monthly": 0,
        "total_yearly": 0,
        "message": "Загрузите выписку, чтобы увидеть найденные подписки",
    }


@app.post("/api/upload")
async def upload_statement(file: UploadFile = File(...)) -> dict:
    """Принимает CSV/PDF-выписку, ищет подписки и сохраняет результат анализа."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Файл пуст")

    fname = (file.filename or "").lower()
    try:
        if fname.endswith(".pdf"):
            txs = parse_pdf(content)
        elif fname.endswith((".csv", ".txt")):
            txs = parse_csv(content)
        else:
            raise HTTPException(
                status_code=422,
                detail="Поддерживаются форматы CSV и PDF (выписка СберБанк Онлайн)",
            )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:  # битый PDF и т.п.
        raise HTTPException(status_code=422, detail=f"Не удалось разобрать файл: {e}") from e

    subs = detect_subscriptions(txs)
    if not subs:
        # Файл распарсен, но подписок нет — график показывает РЕАЛЬНЫЕ расходы,
        # потенциальная экономия = 0 (отменять нечего).
        result = {
            "mock": False,
            "subscriptions": [],
            "monthly": monthly_expense_series_all(txs),
            "total_monthly": 0,
            "total_yearly": 0,
            "message": (f"В выписке «{file.filename}» ({len(txs)} транзакций) не найдено "
                        "регулярных списаний — показаны общие расходы по выписке"),
        }
        save_state(result)
        return result

    # Подписки найдены — обогащаем их Deep Links (cancel_url) и сохраняем.
    subs = enrich_subscriptions(subs)
    result = {
        "mock": False,
        "subscriptions": subs,
        "monthly": monthly_expense_series_from_txs(txs, subs),
        "total_monthly": round(sum(abs(s["monthly_cost"]) for s in subs), 2),
        "total_yearly": round(sum(abs(s["yearly_cost"]) for s in subs), 2),
        "message": f"Выписка «{file.filename}»: {len(txs)} транзакций, найдено подписок: {len(subs)}",
    }
    save_state(result)
    return result


@app.post("/api/reset")
def reset() -> dict:
    """Сбрасывает загруженную выписку, возвращает сервис в исходное состояние."""
    clear_state()
    return {"status": "reset"}


@app.get("/api/generate-test")
def generate_test():
    """Возвращает тестовую CSV-выписку без подписок (для демонстрации Empty State)."""
    from fastapi.responses import Response
    csv_data = generate_test_csv()
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=test_statement.csv"},
    )


@app.get("/api/generate-test-pdf")
def generate_test_pdf_endpoint():
    """Возвращает тестовую PDF-выписку без подписок."""
    from fastapi.responses import Response
    pdf_data = generate_test_pdf()
    return Response(
        content=pdf_data,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=test_statement.pdf"},
    )


@app.get("/api/generate-test-json")
def generate_test_json():
    """Возвращает тестовую выписку для превью: CSV-текст + PDF (base64)."""
    data = generate_test_with_data()
    return {
        "csv_text": data["csv_text"],
        "pdf_base64": data["pdf_base64"],
    }


class LetterRequest(BaseModel):
    name: str
    amount: float | None = None
    period: str = "ежемесячно"



# Зарубежные сервисы, ушедшие из РФ, — им англоязычное письмо без ссылок на
# законы РФ. ВСЕ ОСТАЛЬНЫЕ (включая неизвестные и латинские названия вроде
# «Moscow Rus» — выписки печатают имена латиницей) — русское письмо с законами РФ.
FOREIGN_SERVICES = {
    "netflix", "spotify", "apple music", "apple tv+", "icloud+", "icloud",
    "youtube premium", "google one", "microsoft 365", "adobe",
    "canva", "canva pro", "figma", "notion", "telegram premium",
}


def is_ru_service(name: str) -> bool:
    """Русское письмо — всем, кроме явно известных зарубежных сервисов."""
    low = name.strip().lower()
    return low not in FOREIGN_SERVICES


LETTER_TEMPLATE = """Кому: Служба поддержки «{name}»
Тема: Отказ от автопродления подписки и прекращение списаний

Здравствуйте!

Я, пользователь сервиса «{name}», настоящим уведомляю об отказе от продления
подписки (услуги) с автопродлением{amount_line} и требую прекратить списание
денежных средств с моего банковского счёта.

В соответствии со ст. 32 Закона РФ «О защите прав потребителей» потребитель
вправе отказаться от исполнения договора об оказании услуг в любое время при
оплате фактически понесённых расходов исполнителя. В соответствии со ст. 782
ГК РФ заказчик вправе отказаться от исполнения договора возмездного оказания
услуг при условии оплаты исполнителю фактически понесённых им расходов.

Прошу:
1. Отключить автоматическое продление подписки «{name}».
2. Прекратить дальнейшие списания с моего счёта.
3. Вернуть оплату за неиспользованный период, если списание уже произведено.
4. Подтвердить отключение подписки ответным письмом в течение 10 дней
   (ст. 31 Закона РФ «О защите прав потребителей»).

Дата последнего списания: {last_line}
Дата обращения: {today}

С уважением,
Клиент сервиса «{name}»"""


LETTER_TEMPLATE_EN = """To: {name} Support Team
Subject: Request to cancel subscription and stop recurring charges

Hello,

I am a customer of {name}. I kindly ask you to cancel my subscription and
disable auto-renewal{amount_line_en}, so that no further charges are made to
my card.

Please:
1. Cancel the subscription and auto-renewal for my account.
2. Stop all further recurring charges.
3. Refund the payment for the unused period, if one has already been charged,
   in accordance with the terms of service.
4. Confirm the cancellation by email.

Date: {today}

Best regards,
A customer of {name}"""


@app.post("/api/generate-letter")
def generate_letter(req: LetterRequest) -> dict:
    """Готовит заявление на отмену подписки: российским сервисам — со ссылками
    на законы РФ, зарубежным — англоязычное письмо по их правилам."""
    today = date.today()
    if is_ru_service(req.name):
        amount_line = ""
        if req.amount:
            amount_line = f" в размере {req.amount:,.2f} руб./мес".replace(",", " ")
        letter = LETTER_TEMPLATE.format(
            name=req.name,
            amount_line=amount_line,
            last_line=today.isoformat(),
            today=today.strftime("%d.%m.%Y"),
        )
    else:
        amount_line_en = ""
        if req.amount:
            amount_line_en = f" (currently {req.amount:,.2f} RUB per month)".replace(",", " ")
        letter = LETTER_TEMPLATE_EN.format(
            name=req.name,
            amount_line_en=amount_line_en,
            today=today.strftime("%d.%m.%Y"),
        )
    return {"letter": letter, "name": req.name}


# ---------------------------------------------------------------------------
# Раздача production-сборки фронтенда (один сервер на всё: http://127.0.0.1:8000)
# Монтируется последним, чтобы не перехватывать /api-роуты.
# ---------------------------------------------------------------------------
if _DIST.exists():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(_DIST / "index.html")

    @app.get("/{path:path}", include_in_schema=False)
    def spa_fallback(path: str) -> FileResponse:
        """SPA-fallback: любые не-/api пути отдают index.html."""
        candidate = _DIST / path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_DIST / "index.html")
