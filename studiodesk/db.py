"""The only way to open the two SQLite files (docs/CONTRACT.md, Storage)."""
import json
import sqlite3
from pathlib import Path

from . import config

SCHEMA = Path(__file__).with_name("schema.sql")


def connect(path: Path, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        conn = sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True, check_same_thread=False)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA.read_text())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def matches(readonly: bool = True) -> sqlite3.Connection:
    return connect(config.MATCHES_DB, readonly)


def runtime() -> sqlite3.Connection:
    return connect(config.RUNTIME_DB)


def insert(conn: sqlite3.Connection, table: str, row: dict) -> None:
    """INSERT one row; dict and list values go in as JSON text. Table and keys come from our code only."""
    conn.execute(f"INSERT INTO {table} ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
                 [json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for v in row.values()])
