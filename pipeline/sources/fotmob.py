"""FotMob veri kaynağı — Understat kapsamı dışındaki ligler (şu an Süper Lig).

SofaScore'un yerini aldı. İçerik olarak denk ama tek bir kritik farkı var:
düz `requests` ile erişilebiliyor. SofaScore, Cloudflare arkasında olduğu için
headless Chrome gerektiriyordu ve GitHub Actions runner'larının veri merkezi
IP'lerini engelliyordu; bu yüzden Süper Lig verisi CI'da hiç tazelenemiyordu.

Takım kimliği olarak FotMob'un sayısal `id`si kullanılıyor — Understat'ta
olduğu gibi, isim eşleştirme koduna gerek yok.
"""

from __future__ import annotations

import re
import time
from typing import Any

import pandas as pd
import requests

from pipeline.config import LEAGUES
from pipeline.sources.understat import COLUMNS

BASE_URL = "https://www.fotmob.com/api/data/leagues"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

SCORE_RE = re.compile(r"^\s*(\d+)\s*-\s*(\d+)\s*$")


class FotmobError(RuntimeError):
    pass


def _season_param(season: str) -> str:
    """'2026_2027' -> '2026/2027'"""
    return season.replace("_", "/")


def _get(url: str, params: dict, retries: int = 3, backoff: float = 2.0) -> Any:
    last = None
    for attempt in range(retries):
        try:
            response = requests.get(url, params=params, headers=HEADERS, timeout=30)
            if response.status_code == 200:
                return response.json()
            last = f"HTTP {response.status_code}"
        except (requests.RequestException, ValueError) as exc:
            last = f"{type(exc).__name__}: {exc}"
        if attempt < retries - 1:
            time.sleep(backoff * (attempt + 1))
    raise FotmobError(f"{url} {params} alınamadı ({last})")


def _row(match: dict, league: str, season: str) -> dict | None:
    status = match.get("status") or {}
    home, away = match.get("home") or {}, match.get("away") or {}
    if not home.get("id") or not away.get("id") or not status.get("utcTime"):
        return None

    finished = bool(status.get("finished")) and not status.get("cancelled")
    home_goals = away_goals = None
    if finished:
        found = SCORE_RE.match(str(status.get("scoreStr") or ""))
        if found:
            home_goals, away_goals = float(found.group(1)), float(found.group(2))
        else:
            finished = False  # skor okunamadıysa oynanmamış say, uydurma

    return {
        "match_id": f"fm{match['id']}",
        "datetime": pd.to_datetime(status["utcTime"]).tz_convert(None),
        "league": league,
        "season": season,
        "home_id": f"fm{home['id']}",
        "away_id": f"fm{away['id']}",
        "home_team": home.get("name"),
        "away_team": away.get("name"),
        "home_short": home.get("shortName"),
        "away_short": away.get("shortName"),
        "home_goals": home_goals,
        "away_goals": away_goals,
        "home_xg": None,   # lig fikstür ucunda xG yok
        "away_xg": None,
        "is_result": finished,
    }


def drop_non_league(df: pd.DataFrame) -> pd.DataFrame:
    """Kupa ve hazırlık maçlarını ayıklar — kadro büyüklüğü varsaymadan.

    Ligdeki her takım 2*(N-1) maç oynar (34-38 civarı); kupada karşılaşılan
    alt lig takımı bir veya iki kez görünür. Medyanın yarısı bu ikisini
    temiz ayırır ve ligin kaç takımlı olduğunu bilmeyi gerektirmez.

    Bu, sabit bir takım sayısına göre "en çok oynayan N takımı al" demekten
    daha güvenli: Süper Lig 2023/24'te 20, 2024/25'te 19, sonra 18 takımlıydı
    ve sabit bir N gerçek lig maçlarını kırpıyordu.
    """
    if df.empty:
        return df
    counts = pd.concat([df["home_id"], df["away_id"]]).value_counts()
    roster = set(counts[counts >= counts.median() * 0.5].index)
    return df[df["home_id"].isin(roster) & df["away_id"].isin(roster)]


def fetch_league_season(league: str, season: str) -> pd.DataFrame:
    """Bir lig-sezonu Understat ile aynı şemada döndürür."""
    cfg = LEAGUES[league]
    league_id = cfg.get("fotmob")
    if not league_id:
        raise ValueError(f"{league} FotMob kapsamında değil")

    wanted = _season_param(season)
    payload = _get(BASE_URL, {"id": league_id, "season": wanted})

    available = payload.get("allAvailableSeasons") or []
    if not available:
        raise FotmobError(f"lig {league_id} için sezon listesi boş — erişim engellenmiş olabilir")
    if wanted not in available:
        return pd.DataFrame(columns=COLUMNS)

    returned = (payload.get("details") or {}).get("selectedSeason")
    if returned and returned != wanted:
        raise FotmobError(f"{wanted} istendi ama {returned} döndü")

    matches = (payload.get("fixtures") or {}).get("allMatches") or []
    rows = [r for r in (_row(m, league, season) for m in matches) if r]
    if not rows:
        return pd.DataFrame(columns=COLUMNS)

    df = pd.DataFrame(rows, columns=COLUMNS).drop_duplicates(subset=["match_id"])
    df = drop_non_league(df)
    df = df.drop_duplicates(subset=["home_id", "away_id"], keep="first")

    for col in ("home_goals", "away_goals", "home_xg", "away_xg"):
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("float64")
    df["is_result"] = df["is_result"].astype(bool)
    df["has_xg"] = False
    return df.sort_values("datetime").reset_index(drop=True)
