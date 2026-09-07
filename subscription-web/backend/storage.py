"""SQLite-хранилище результата последнего анализа выписки.

Раньше состояние жило в памяти процесса и терялось при перезапуске uvicorn;
теперь анализ сохраняется в scanner.db рядом с backend/ и переживает рестарт.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path

_DB_PATH = Path(__file__).resolve().parent / "scanner.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS state ("
        " id INTEGER PRIMARY KEY CHECK (id = 1),"
        " payload TEXT NOT NULL)"
    )
    return conn


def save_state(payload: dict) -> None:
    """Сохраняет результат анализа (единственная строка id=1)."""
    with closing(_connect()) as conn, conn:
        conn.execute(
            "INSERT INTO state (id, payload) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
            (json.dumps(payload, ensure_ascii=False),),
        )


def load_state() -> dict | None:
    """Возвращает последний анализ или None, если выписка не загружалась."""
    with closing(_connect()) as conn:
        row = conn.execute("SELECT payload FROM state WHERE id = 1").fetchone()
    return json.loads(row[0]) if row else None


def clear_state() -> None:
    """Сбрасывает состояние (кнопка «Другая выписка» / POST /api/reset)."""
    with closing(_connect()) as conn, conn:
        conn.execute("DELETE FROM state WHERE id = 1")
