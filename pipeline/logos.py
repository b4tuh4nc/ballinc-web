"""Takım ve lig logolarını indirip web/assets/ altına koyar.

Logolar siteye gömülü (hotlink değil) tutuluyor: kaynak CDN'i engellerse ya
da yolunu değiştirirse site logosuz kalmasın. Dosya adı bizim kanonik takım
kimliğimiz, yani ön yüz `assets/teams/<takım_id>.png` diyerek erişiyor ve
JSON'da ayrıca logo alanı taşımaya gerek kalmıyor.

Bir kez indirilir; var olan dosya tekrar indirilmez.
"""

from __future__ import annotations

import time

import pandas as pd
import requests

from pipeline import crosswalk
from pipeline.config import (
    FOTMOB_LEAGUES,
    FOTMOB_PRIMARY_LEAGUES,
    LEAGUES,
    SEASONS,
    WEB_DIR,
    raw_path,
)

TEAM_LOGO = "https://images.fotmob.com/image_resources/logo/teamlogo/{id}.png"
LEAGUE_LOGO = "https://images.fotmob.com/image_resources/logo/leaguelogo/{id}.png"
LEAGUE_LOGO_DARK = "https://images.fotmob.com/image_resources/logo/leaguelogo/dark/{id}.png"

ASSETS = WEB_DIR / "assets"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
}
MIN_BYTES = 500  # bundan küçük yanıt muhtemelen hata sayfası, logo değil


def _download(url: str, path, session: requests.Session) -> bool:
    if path.exists() and path.stat().st_size >= MIN_BYTES:
        return False
    try:
        response = session.get(url, headers=HEADERS, timeout=20)
    except requests.RequestException:
        return False
    if response.status_code != 200 or len(response.content) < MIN_BYTES:
        return False
    if not response.headers.get("content-type", "").startswith("image/"):
        return False

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(response.content)
    tmp.replace(path)
    time.sleep(0.15)
    return True


def canonical_team_ids() -> dict[str, str]:
    """Kanonik takım kimliği → FotMob id (logo bu id ile indiriliyor)."""
    mapping = {
        understat_id: entry["fotmob_id"]
        for understat_id, entry in crosswalk.load().items()
    }
    # FotMob'un birincil kaynak olduğu liglerde kimlik zaten FotMob id'si.
    for league in FOTMOB_PRIMARY_LEAGUES:
        for season in SEASONS:
            path = raw_path(league, season)
            if not path.exists():
                continue
            raw = pd.read_parquet(path)
            for column in ("home_id", "away_id"):
                for team_id in raw[column].unique():
                    mapping[team_id] = str(team_id).removeprefix("fm")
    return mapping


def main() -> int:
    session = requests.Session()

    leagues_done = 0
    for code in FOTMOB_LEAGUES:
        league_id = LEAGUES[code]["fotmob"]
        for url, name in (
            (LEAGUE_LOGO.format(id=league_id), f"{code}.png"),
            (LEAGUE_LOGO_DARK.format(id=league_id), f"{code}-dark.png"),
        ):
            leagues_done += _download(url, ASSETS / "leagues" / name, session)

    teams = canonical_team_ids()
    if not teams:
        print("Takım eşlemesi boş. Önce `python -m pipeline.crosswalk` çalıştır.")
        return 1

    downloaded = 0
    for canonical_id, fotmob_id in sorted(teams.items()):
        downloaded += _download(
            TEAM_LOGO.format(id=fotmob_id),
            ASSETS / "teams" / f"{canonical_id}.png",
            session,
        )

    have = len(list((ASSETS / "teams").glob("*.png")))
    missing = [t for t in teams if not (ASSETS / "teams" / f"{t}.png").exists()]
    print(f"Lig logosu: {leagues_done} yeni · Takım logosu: {downloaded} yeni, "
          f"toplam {have}/{len(teams)}")
    if missing:
        print(f"  ! {len(missing)} takımın logosu indirilemedi: {missing[:8]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
