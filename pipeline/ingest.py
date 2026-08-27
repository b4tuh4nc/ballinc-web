"""Ham veri girişi: kaynaklardan çek, data/raw/<lig>_<sezon>.parquet olarak yaz.

Yazım atomik (geçici dosya -> rename): yarıda kesilen bir çekim mevcut
dosyayı bozmaz. Eski sistemde bozuk parquet'ler sessizce üretiliyordu.
"""

from __future__ import annotations

import argparse
import sys
import time

import pandas as pd

from pipeline import crosswalk
from pipeline.config import (
    FOTMOB_PRIMARY_LEAGUES,
    LEAGUES,
    RAW_DIR,
    SEASONS,
    UNDERSTAT_LEAGUES,
    raw_path,
    season_label,
)
from pipeline.sources import fotmob, understat


def _write_atomic(df: pd.DataFrame, path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    df.to_parquet(tmp, index=False)
    tmp.replace(path)


def canonicalise(df: pd.DataFrame, league: str) -> pd.DataFrame:
    """Takım ve maç kimliklerini kaynaktan bağımsız hale getirir.

    İki sorunu birden çözüyor:

    1. Bir lig-sezon yedek kaynaktan gelirse (Understat henüz yayınlamamışsa
       FotMob'dan) takımlar `fm...` kimliğiyle gelir ve aynı takımın önceki
       sezonlardaki `us...` geçmişinden kopar. Elo ve form sıfırlanmış olur.
       Crosswalk ile kanonik kimliğe çevriliyor.

    2. Maç kimliği kaynağın kendi id'siydi; kaynak değişince aynı maçın
       kimliği de değişiyordu. Artık (lig, sezon, ev, deplasman) üçlüsünden
       türetiliyor — bir fikstürü tek anlamlı şekilde tanımlayan şey zaten bu.
       Böylece kaydedilmiş bir tahmin, maç başka bir kaynaktan gelse de
       sonucuyla eşleşebiliyor.
    """
    if df.empty:
        return df

    if LEAGUES[league].get("understat"):
        entries = crosswalk.load()
        by_fotmob = {e["fotmob_id"]: (us_id, e["understat_name"])
                     for us_id, e in entries.items()}
        for side in ("home", "away"):
            ids, names = [], []
            for team_id, name in zip(df[f"{side}_id"], df[f"{side}_team"]):
                found = by_fotmob.get(str(team_id).removeprefix("fm"))
                if str(team_id).startswith("fm") and found:
                    ids.append(found[0])
                    names.append(found[1])
                else:
                    ids.append(team_id)
                    names.append(name)
            df[f"{side}_id"] = ids
            df[f"{side}_team"] = names

    df["match_id"] = (
        df["league"] + "-" + df["season"] + "-" + df["home_id"] + "-" + df["away_id"]
    )
    return df


def ingest_understat(leagues: list[str], seasons: list[str]) -> int:
    failures = 0
    for league in leagues:
        for season in seasons:
            label = f"{league} {season_label(season)}"
            try:
                df = understat.fetch_league_season(league, season)
            except understat.UnderstatError as exc:
                print(f"  ✗ {label:24s} {exc}")
                failures += 1
                continue

            source = "Understat"
            if df.empty:
                # Understat sezon başında fikstürü geç yayınlayabiliyor
                # (Bundesliga 26/27 böyleydi). Oynanmamış maçlarda xG zaten
                # yok, dolayısıyla FotMob'dan gelen fikstür hiçbir şey
                # kaybettirmiyor; Understat yayınlayınca devralıyor.
                try:
                    df = fotmob.fetch_league_season(league, season)
                    source = "FotMob (yedek)"
                except Exception as exc:
                    print(f"  · {label:24s} fikstür yok, yedek kaynak da "
                          f"başarısız ({type(exc).__name__})")
                    continue
                if df.empty:
                    print(f"  · {label:24s} fikstür henüz yayınlanmamış, atlandı")
                    continue

            df = canonicalise(df, league)
            played = int(df["is_result"].sum())
            with_xg = int(df["has_xg"].sum())
            _write_atomic(df, raw_path(league, season))
            print(
                f"  ✓ {label:24s} {len(df):3d} maç  "
                f"({played:3d} oynanmış, {with_xg:3d} xG'li)"
                + ("" if source == "Understat" else f"  [{source}]")
            )
    return failures


def ingest_fotmob(leagues: list[str], seasons: list[str]) -> int:
    """FotMob — Understat kapsamı dışındaki ligler.

    Çekim başarısızsa diskteki mevcut dosya korunuyor ve bu bir hata değil
    "tazelenemedi" olarak sayılıyor: tek bir ligin erişim sorunu bütün
    gecelik akışı durdurmamalı.
    """
    failures = 0
    for league in leagues:
        for season in seasons:
            label = f"{league} {season_label(season)}"
            path = raw_path(league, season)
            try:
                df = fotmob.fetch_league_season(league, season)
            except Exception as exc:
                if path.exists():
                    print(f"  ! {label:24s} tazelenemedi, mevcut veri korundu "
                          f"({type(exc).__name__}: {exc})")
                else:
                    print(f"  ✗ {label:24s} {type(exc).__name__}: {exc}")
                    failures += 1
                continue

            if df.empty:
                print(f"  · {label:24s} sezon henüz açılmamış, atlandı")
                continue

            df = canonicalise(df, league)
            teams = len(set(df["home_id"]) | set(df["away_id"]))
            played = int(df["is_result"].sum())
            _write_atomic(df, path)
            print(f"  ✓ {label:24s} {len(df):3d} maç, {teams:2d} takım  "
                  f"({played:3d} oynanmış, xG yok)")
            time.sleep(1.0)
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Ham maç verisini çeker")
    parser.add_argument("--leagues", nargs="*", default=None,
                        help="varsayılan: yapılandırmadaki bütün ligler")
    parser.add_argument("--seasons", nargs="*", default=SEASONS)
    args = parser.parse_args()

    wanted = set(args.leagues) if args.leagues else None
    us = [l for l in UNDERSTAT_LEAGUES if wanted is None or l in wanted]
    fm = [l for l in FOTMOB_PRIMARY_LEAGUES if wanted is None or l in wanted]

    failures = 0
    if us:
        print(f"Understat → {RAW_DIR}")
        failures += ingest_understat(us, args.seasons)
    if fm:
        print(f"\nFotMob → {RAW_DIR}")
        failures += ingest_fotmob(fm, args.seasons)

    if failures:
        print(f"\n{failures} lig-sezon çekilemedi.")
        return 1
    print("\nGiriş tamam.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
