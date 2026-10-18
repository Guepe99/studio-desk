"""Forbidden real names (docs/CONTRACT.md, Identifiers). Shared by the simulator and the verifier."""
import re
import unicodedata
from functools import lru_cache

from . import config


def _fold(text: str) -> str:
    # "Mbappé" must match "Mbappe": compare without accents, case-insensitive.
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().casefold()


@lru_cache(maxsize=1)
def _pattern() -> re.Pattern:
    lines = config.FORBIDDEN_NAMES.read_text(encoding="utf-8").splitlines()
    names = [_fold(n.strip()) for n in lines if n.strip() and not n.lstrip().startswith("#")]
    names.sort(key=len, reverse=True)
    return re.compile(r"(?<!\w)(" + "|".join(map(re.escape, names)) + r")(?!\w)")


def find_forbidden(text: str) -> list[str]:
    """Real names found in text, as written in the list (folded)."""
    return _pattern().findall(_fold(text))


def is_forbidden(text: str) -> bool:
    return bool(_pattern().search(_fold(text)))
