"""Bahis oranları (the-odds-api) — piyasa olasılıkları ve değer bahis girdisi.

Ne yapıyor:
  1. Her bahisçinin 1/X/2 oranını olasılığa çevirir.
  2. Bahisçinin kâr marjını (overround) temizler. Ham oranlardan çıkan
     olasılıklar %100 değil ~%105-108 toplar; aradaki fark bahisçinin payıdır
     ve temizlenmeden model ile kıyaslanamaz.
  3. Bahisçiler arasında medyan alır. Tek bir bahisçinin sapması sonucu
     bozmasın diye ortalama değil medyan kullanılıyor.

API anahtarı ODDS_API_KEY ortam değişkeninden okunuyor; repo açık olduğu için
hiçbir dosyaya yazılmıyor (CI'da GitHub secret olarak duruyor).
"""

from __future__ import annotations

import os
from difflib import SequenceMatcher

import numpy as np
import requests

from pipeline.crosswalk import normalise

BASE_URL = "https://api.the-odds-api.com/v4/sports/{sport}/odds"

SPORT_KEYS = {
    "EPL": "soccer_epl",
    "La_Liga": "soccer_spain_la_liga",
    "Serie_A": "soccer_italy_serie_a",
    "Bundesliga": "soccer_germany_bundesliga",
    "Ligue_1": "soccer_france_ligue_one",
    "TSL": "soccer_turkey_super_league",
}

MATCH_THRESHOLD = 0.70
MIN_BOOKMAKERS = 3


class OddsError(RuntimeError):
    pass


def api_key() -> str | None:
    return os.environ.get("ODDS_API_KEY") or None


def _demargin(prices: dict[str, float]) -> dict[str, float] | None:
    """Bir bahisçinin oranlarını marjsız olasılığa çevirir."""
    if len(prices) != 3 or any(p <= 1.0 for p in prices.values()):
        return None
    raw = {k: 1.0 / v for k, v in prices.items()}
    total = sum(raw.values())
    if not (1.0 < total < 1.5):        # makul marj dışındaysa veri şüpheli
        return None
    return {k: v / total for k, v in raw.items()}


def _consensus(event: dict):
    """Marjsız konsensüs olasılıkları + piyasadaki en iyi oranlar.

    Konsensüs "piyasa ne düşünüyor" sorusunun cevabı; en iyi oran ise
    beklenen değer hesabı için gerekli, çünkü bahis oynayan kişi ortalama
    oranı değil bulabildiği en yüksek oranı alır.
    """
    per_book: list[dict[str, float]] = []
    margins: list[float] = []
    best: dict[str, float] = {}

    for book in event.get("bookmakers", []):
        for market in book.get("markets", []):
            if market.get("key") != "h2h":
                continue
            prices = {o["name"]: float(o["price"]) for o in market.get("outcomes", [])
                      if o.get("price")}
            for name, price in prices.items():
                if price > best.get(name, 0.0):
                    best[name] = price
            fair = _demargin(prices)
            if fair:
                per_book.append(fair)
                margins.append(sum(1.0 / p for p in prices.values()) - 1.0)

    if len(per_book) < MIN_BOOKMAKERS:
        return None

    keys = per_book[0].keys()
    median = {k: float(np.median([b[k] for b in per_book if k in b])) for k in keys}
    total = sum(median.values())
    if total <= 0:
        return None
    return ({k: v / total for k, v in median.items()},
            len(per_book), float(np.median(margins)), best)


def resolve_teams(our_teams: dict[str, str], odds_names: set[str]) -> dict[str, str]:
    """Oran sağlayıcısının takım adlarını bizim kanonik kimliğimize bağlar.

    Eşleşmeyen isim atlanıyor, hata verilmiyor: oran verisi tamamen ek bir
    katman, bir takımın oranı gelmezse o maçta sadece piyasa kıyası olmaz.
    """
    normalised = {team_id: normalise(name) for team_id, name in our_teams.items()}
    mapping: dict[str, str] = {}
    for name in odds_names:
        target = normalise(name)
        best_id, best_score = None, 0.0
        for team_id, candidate in normalised.items():
            if candidate == target:
                best_id, best_score = team_id, 1.0
                break
            score = SequenceMatcher(None, candidate, target).ratio()
            short, long = sorted((candidate, target), key=len)
            if short and long.startswith(short + " "):
                score = max(score, 0.95)
            if score > best_score:
                best_id, best_score = team_id, score
        if best_score >= MATCH_THRESHOLD:
            mapping[name] = best_id
    return mapping


def fetch_league(league: str, our_teams: dict[str, str],
                 key: str | None = None) -> tuple[dict[tuple[str, str], dict], dict]:
    """Bir ligin yaklaşan maçları için piyasa olasılıkları.

    Dönen sözlüğün anahtarı (ev_takım_id, deplasman_takım_id).
    """
    key = key or api_key()
    if not key:
        raise OddsError("ODDS_API_KEY tanımlı değil")
    sport = SPORT_KEYS.get(league)
    if not sport:
        raise OddsError(f"{league} için oran kaynağı yok")

    response = requests.get(
        BASE_URL.format(sport=sport),
        params={"apiKey": key, "regions": "eu", "markets": "h2h",
                "oddsFormat": "decimal"},
        timeout=30,
    )
    if response.status_code != 200:
        raise OddsError(f"{league}: HTTP {response.status_code} {response.text[:120]}")

    events = response.json()
    quota = {
        "remaining": response.headers.get("x-requests-remaining"),
        "used": response.headers.get("x-requests-used"),
    }

    names = {n for e in events for n in (e.get("home_team"), e.get("away_team")) if n}
    resolved = resolve_teams(our_teams, names)

    out: dict[tuple[str, str], dict] = {}
    for event in events:
        home_id = resolved.get(event.get("home_team"))
        away_id = resolved.get(event.get("away_team"))
        if not home_id or not away_id:
            continue
        consensus = _consensus(event)
        if not consensus:
            continue
        probs, books, margin, best = consensus

        # API sonuç adlarını takım adıyla veriyor; 1/X/2 sırasına çeviriyoruz.
        order = (event["home_team"], "Draw", event["away_team"])
        fair = [probs.get(name) for name in order]
        prices = [best.get(name) for name in order]
        if any(v is None for v in fair) or any(v is None for v in prices):
            continue

        out[(home_id, away_id)] = {
            "market": [round(v, 4) for v in fair],
            "best_odds": [round(v, 2) for v in prices],
            "bookmakers": books,
            "margin": round(margin, 4),
        }
    return out, quota


def expected_value(model_probs: list[float], best_odds: list[float]) -> list[float]:
    """EV = p_model × (oran − 1) − (1 − p_model), her sonuç için.

    Pozitif değer, modelin o sonuca piyasanın verdiği fiyattan daha yüksek
    ihtimal biçtiği anlamına gelir. Modelin piyasadan gerçekten iyi olduğu
    doğrulanmadan bu bir kâr vaadi DEĞİLDİR; bkz. track.py'deki model-piyasa
    karşılaştırması.
    """
    return [
        round(p * (o - 1.0) - (1.0 - p), 4)
        for p, o in zip(model_probs, best_odds)
    ]
