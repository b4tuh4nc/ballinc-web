"""Ham veri girişi: kaynaklardan çek, data/raw/<lig>_<sezon>.parquet olarak yaz.

Yazım atomik (geçici dosya -> rename): yarıda kesilen bir çekim mevcut
dosyayı bozmaz. Eski sistemde bozuk parquet'ler sessizce üretiliyordu.
"""

from __future__ import annotations

import argparse
import sys

import pandas as pd

from pipeline.config import (
    RAW_DIR,
    SEASONS,
    SOFASCORE_LEAGUES,
    UNDERSTAT_LEAGUES,
    raw_path,
    season_label,
)
from pipeline.sources import sofascore, understat


def _write_atomic(df: pd.DataFrame, path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    df.to_parquet(tmp, index=False)
    tmp.replace(path)


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

            if df.empty:
                print(f"  · {label:24s} fikstür henüz yayınlanmamış, atlandı")
                continue

            played = int(df["is_result"].sum())
            with_xg = int(df["has_xg"].sum())
            _write_atomic(df, raw_path(league, season))
            print(
                f"  ✓ {label:24s} {len(df):3d} maç  "
                f"({played:3d} oynanmış, {with_xg:3d} xG'li)"
            )
    return failures


def ingest_sofascore(leagues: list[str], seasons: list[str]) -> int:
    """SofaScore tek bir tarayıcı oturumunu bütün lig-sezonlar için paylaşır.

    SofaScore veri merkezi IP'lerini engelleyebiliyor, dolayısıyla bu kaynak
    CI'da çalışmayabilir. Çekim başarısızsa diskteki mevcut dosya korunuyor
    ve bu bir hata değil "tazelenemedi" olarak sayılıyor — yoksa tek bir
    ligin erişim sorunu bütün gecelik akışı durdururdu.
    """
    failures = 0
    with sofascore.browser() as driver:
        for league in leagues:
            for season in seasons:
                label = f"{league} {season_label(season)}"
                path = raw_path(league, season)
                try:
                    df = sofascore.fetch_league_season(league, season, driver=driver)
                except Exception as exc:
                    if path.exists():
                        print(f"  ! {label:24s} tazelenemedi, mevcut veri korundu "
                              f"({type(exc).__name__})")
                    else:
                        print(f"  ✗ {label:24s} {type(exc).__name__}: {exc}")
                        failures += 1
                    continue

                if df.empty:
                    print(f"  · {label:24s} sezon henüz açılmamış, atlandı")
                    continue

                played = int(df["is_result"].sum())
                _write_atomic(df, path)
                print(f"  ✓ {label:24s} {len(df):3d} maç  "
                      f"({played:3d} oynanmış, xG yok)")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Ham maç verisini çeker")
    parser.add_argument("--leagues", nargs="*", default=None,
                        help="varsayılan: yapılandırmadaki bütün ligler")
    parser.add_argument("--seasons", nargs="*", default=SEASONS)
    parser.add_argument("--skip-sofascore", action="store_true",
                        help="Selenium gerektiren kaynakları atla")
    args = parser.parse_args()

    wanted = set(args.leagues) if args.leagues else None
    us = [l for l in UNDERSTAT_LEAGUES if wanted is None or l in wanted]
    ss = [l for l in SOFASCORE_LEAGUES if wanted is None or l in wanted]

    failures = 0
    if us:
        print(f"Understat → {RAW_DIR}")
        failures += ingest_understat(us, args.seasons)
    if ss and not args.skip_sofascore:
        print(f"\nSofaScore (Selenium) → {RAW_DIR}")
        failures += ingest_sofascore(ss, args.seasons)

    if failures:
        print(f"\n{failures} lig-sezon çekilemedi.")
        return 1
    print("\nGiriş tamam.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
