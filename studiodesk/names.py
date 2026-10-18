"""Forbidden real names (docs/CONTRACT.md, Identifiers). Shared by the simulator and the verifier."""
import re
import unicodedata
from functools import lru_cache

from . import config


# letters NFKD does not split into base + accent
_LATIN = str.maketrans({"ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i"})


def _fold(text: str) -> str:
    # "Mbappé", "Ødegaard", "Arsenal’s", "Alexander–Arnold": compare plain lowercase words joined by
    # one space, so accents, curly apostrophes, dashes and line breaks cannot hide a name.
    text = unicodedata.normalize("NFKD", text.casefold().translate(_LATIN))
    return " ".join(re.findall(r"[a-z0-9]+", "".join(c for c in text if not unicodedata.combining(c))))


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
