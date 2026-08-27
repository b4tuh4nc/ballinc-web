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
    UNDERSTAT_LEAGUES,
    raw_path,
    season_label,
)
from pipeline.sources import understat


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


def main() -> int:
    parser = argparse.ArgumentParser(description="Ham maç verisini çeker")
    parser.add_argument("--leagues", nargs="*", default=UNDERSTAT_LEAGUES)
    parser.add_argument("--seasons", nargs="*", default=SEASONS)
    args = parser.parse_args()

    print(f"Understat → {RAW_DIR}")
    failures = ingest_understat(args.leagues, args.seasons)

    if failures:
        print(f"\n{failures} lig-sezon çekilemedi.")
        return 1
    print("\nGiriş tamam.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
