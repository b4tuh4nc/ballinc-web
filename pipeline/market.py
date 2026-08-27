"""Bahis oranlarını çeker ve data/market_odds.json'a yazar.

Ağ erişimi burada izole: `export` ve `track` yalnızca bu dosyanın çıktısını
okur. Oran servisi çökerse ya da kota biterse site son bilinen oranlarla
çalışmaya devam eder, hiçbir tahmin kaybolmaz.

Ücretsiz kota 500 istek/ay. Market başına 1 kredi harcandığı için yalnızca
1X2 (h2h) çekiliyor: 6 lig × günde 1 = ayda ~180 istek. Alt/üst ve karşılıklı
gol oranları da alınabilirdi ama ölçümde modelin o marketlerde piyasayı
geçecek bir avantajı zaten yok; kotayı oraya harcamanın anlamı yok.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

import pandas as pd

from pipeline.config import CURRENT_SEASON, DATA_DIR, LEAGUES, raw_path
from pipeline.sources import odds

MARKET_PATH = DATA_DIR / "market_odds.json"


def league_teams(league: str) -> dict[str, str]:
    """Güncel sezondaki takımlar: kanonik kimlik → görünen ad."""
    path = raw_path(league, CURRENT_SEASON)
    if not path.exists():
        return {}
    df = pd.read_parquet(path)
    teams: dict[str, str] = {}
    for row in df.itertuples(index=False):
        teams[row.home_id] = row.home_team
        teams[row.away_id] = row.away_team
    return teams


def attach(predictions: list[dict]) -> int:
    """Her maça piyasa olasılığını ve beklenen değeri ekler.

    EV pozitifse model o sonuca piyasanın fiyatladığından daha yüksek ihtimal
    veriyor demektir. Bu bir kâr vaadi DEĞİL: modelin piyasayı gerçekten
    geçtiği, tahminler sonuçlandıkça `track.py` içinde ölçülüyor ve sitede
    ayrıca yayınlanıyor.
    """
    entries = load().get("odds", {})
    if not entries:
        return 0

    hits = 0
    for match in predictions:
        key = f"{match['league']}|{match['home']['id']}|{match['away']['id']}"
        found = entries.get(key)
        if not found:
            continue
        model_probs = match["markets"]["result"]
        match["market"] = {
            "probs": found["market"],
            "best_odds": found["best_odds"],
            "bookmakers": found["bookmakers"],
            "margin": found["margin"],
            "ev": odds.expected_value(model_probs, found["best_odds"]),
        }
        hits += 1
    return hits


def load() -> dict:
    if not MARKET_PATH.exists():
        return {}
    return json.loads(MARKET_PATH.read_text(encoding="utf-8"))


def main() -> int:
    key = odds.api_key()
    if not key:
        print("ODDS_API_KEY tanımlı değil, oran adımı atlandı.")
        return 0

    previous = load()
    entries: dict[str, dict] = dict(previous.get("odds", {}))
    quota = None
    failed = []

    for league in LEAGUES:
        if league not in odds.SPORT_KEYS:
            continue
        teams = league_teams(league)
        if not teams:
            continue
        try:
            fetched, quota = odds.fetch_league(league, teams, key)
        except Exception as exc:
            # Bir ligin oranı gelmezse eskisi korunuyor; akış durmuyor.
            print(f"  ! {league:12s} alınamadı ({type(exc).__name__}: {exc})")
            failed.append(league)
            continue

        for (home_id, away_id), value in fetched.items():
            entries[f"{league}|{home_id}|{away_id}"] = value
        print(f"  ✓ {league:12s} {len(fetched):2d} maç")

    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "quota_remaining": (quota or {}).get("remaining"),
        "odds": entries,
    }
    MARKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    MARKET_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"\n{len(entries)} maçlık oran → {MARKET_PATH}")
    if payload["quota_remaining"] is not None:
        print(f"Kalan aylık kota: {payload['quota_remaining']}")
    if failed:
        print(f"{len(failed)} lig alınamadı, eski oranları korundu: {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
