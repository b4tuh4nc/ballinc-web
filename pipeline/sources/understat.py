"""Understat veri kaynağı — 5 Avrupa ligi için sonuç, xG ve fikstür.

Neden bu kaynak birincil:
  * Lig-saf: sadece lig maçları döner, kupa/Avrupa maçı sızmaz.
  * Takım kimliği stabil: her takımın sayısal `id`si var ve sezonlar boyunca
    sabit. Eski sistemi bitiren isim eşleştirme problemi burada hiç doğmuyor.
  * Oynanmamış maçlar da fikstür saatiyle birlikte geliyor.
"""

from __future__ import annotations

import time
from typing import Any

import pandas as pd
import requests

from pipeline.config import LEAGUES, LEAK_FIELDS, understat_year

BASE_URL = "https://understat.com/getLeagueData/{slug}/{year}"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "X-Requested-With": "XMLHttpRequest",
}

# Bütün kaynaklar bu şemayı üretir.
# `round` (hafta) Understat'ta yok; FotMob'dan tamamlanıyor (bkz. rounds.py).
COLUMNS = [
    "match_id", "datetime", "league", "season",
    "home_id", "away_id", "home_team", "away_team", "home_short", "away_short",
    "home_goals", "away_goals", "home_xg", "away_xg", "is_result", "round",
]


class UnderstatError(RuntimeError):
    pass


def _get_json(url: str, retries: int = 3, backoff: float = 2.0) -> Any:
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            if r.status_code == 200:
                return r.json()
            last = f"HTTP {r.status_code}"
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}: {exc}"
        if attempt < retries - 1:
            time.sleep(backoff * (attempt + 1))
    raise UnderstatError(f"{url} alınamadı ({last})")


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _row(match: dict, league: str, season: str) -> dict:
    home, away = match["h"], match["a"]
    goals = match.get("goals") or {}
    xg = match.get("xG") or {}
    return {
        "match_id": f"us{match['id']}",
        "datetime": match["datetime"],
        "league": league,
        "season": season,
        "home_id": f"us{home['id']}",
        "away_id": f"us{away['id']}",
        "home_team": home["title"],
        "away_team": away["title"],
        "home_short": home.get("short_title"),
        "away_short": away.get("short_title"),
        "home_goals": _num(goals.get("h")),
        "away_goals": _num(goals.get("a")),
        "home_xg": _num(xg.get("h")),
        "away_xg": _num(xg.get("a")),
        "is_result": match.get("isResult") in (True, "true", 1, "1"),
        "round": None,  # Understat hafta bilgisi vermiyor
    }


def fetch_league_season(league: str, season: str) -> pd.DataFrame:
    """Bir lig-sezonu normalize edilmiş DataFrame olarak döndürür.

    Fikstür henüz yayınlanmamışsa (sezon başında olabiliyor) boş DataFrame
    döner — bu bir hata değil, `ingest` bunu "henüz yok" olarak ele alır.
    """
    slug = LEAGUES[league].get("understat")
    if not slug:
        raise ValueError(f"{league} Understat kapsamında değil")

    payload = _get_json(BASE_URL.format(slug=slug, year=understat_year(season)))
    if isinstance(payload, dict):
        payload = payload.get("dates") or payload.get("datesData") or []
    if not payload:
        return pd.DataFrame(columns=COLUMNS)

    df = pd.DataFrame([_row(m, league, season) for m in payload], columns=COLUMNS)

    # Sızıntılı alanlar ham veriye bile girmesin (bkz. config.LEAK_FIELDS).
    leaked = LEAK_FIELDS & set(df.columns)
    if leaked:
        raise UnderstatError(f"Sızıntılı alan normalize çıktısına kaçmış: {leaked}")

    df["datetime"] = pd.to_datetime(df["datetime"], utc=False)
    for col in ("home_goals", "away_goals", "home_xg", "away_xg"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Oynanmamış maçta skor/xG olmamalı; kaynak tutarsızsa temizle.
    unplayed = ~df["is_result"]
    df.loc[unplayed, ["home_goals", "away_goals", "home_xg", "away_xg"]] = pd.NA

    df["has_xg"] = df["home_xg"].notna() & df["away_xg"].notna()
    return df.sort_values("datetime").reset_index(drop=True)
