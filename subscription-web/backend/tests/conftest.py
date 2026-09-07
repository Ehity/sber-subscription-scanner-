import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

import storage


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path):
    """Тесты работают с временной БД и не трогают реальный scanner.db."""
    storage._DB_PATH = tmp_path / "test.db"
    yield
