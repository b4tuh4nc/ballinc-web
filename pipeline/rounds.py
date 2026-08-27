"""Understat maçlarına hafta (round) numarasını FotMob'dan ekler.

Understat hafta bilgisi vermiyor. Haftayı tarihten tahmin etmek cazip ama
yanlış: ertelenen maçlar tarih sırasını bozar ve maç yanlış haftaya düşer.
FotMob her maçın gerçek hafta numarasını veriyor, o yüzden crosswalk üzerinden
bire bir bağlanıyor.

Yalnızca güncel sezon işleniyor — hafta numarası sadece sitede maçları
gruplamak için kullanılıyor, geçmiş sezonlar gösterilmiyor.
"""

from __future__ import annotations

import time

import pandas as pd

from pipeline import crosswalk
from pipeline.config import CURRENT_SEASON, UNDERSTAT_LEAGUES, raw_path, season_label
from pipeline.sources import fotmob


def fill_rounds(league: str, season: str, mapping: dict) -> tuple[int, int]:
    """Bir lig-sezonun round sütununu doldurur. (doldurulan, toplam) döndürür."""
    path = raw_path(league, season)
    if not path.exists():
        return 0, 0

    df = pd.read_parquet(path)
    if df.empty:
        return 0, 0

    matches = fotmob.fetch_matches(league, season)
    if not matches:
        return 0, len(df)
    _, rounds = fotmob.teams_and_rounds(matches)

    def to_fotmob(team_id: str) -> str | None:
        # Yedek kaynaktan gelen ve Understat'ta hiç görünmemiş takımlar
        # (yeni çıkanlar) zaten FotMob kimliğini taşıyor; crosswalk'ta
        # bulunmamaları normal, kimliği doğrudan kullanmak gerekiyor.
        if str(team_id).startswith("fm"):
            return str(team_id).removeprefix("fm")
        return mapping.get(team_id)

    def lookup(row):
        home, away = to_fotmob(row.home_id), to_fotmob(row.away_id)
        if home is None or away is None:
            return pd.NA
        return rounds.get((home, away), pd.NA)

    resolved = [lookup(row) for row in df.itertuples(index=False)]
    resolved = pd.to_numeric(pd.Series(resolved, index=df.index), errors="coerce")
    # Yeni değer bulunamayan satırlarda mevcut hafta korunuyor: kaynak zaten
    # doğru haftayı vermişse onu silmenin anlamı yok.
    existing = pd.to_numeric(df.get("round"), errors="coerce")
    df["round"] = resolved.fillna(existing).astype("Int64")

    tmp = path.with_suffix(".parquet.tmp")
    df.to_parquet(tmp, index=False)
    tmp.replace(path)
    return int(df["round"].notna().sum()), len(df)


def main() -> int:
    mapping = {
        understat_id: entry["fotmob_id"]
        for understat_id, entry in crosswalk.load().items()
    }
    if not mapping:
        print("Takım eşlemesi yok. Önce `python -m pipeline.crosswalk` çalıştır.")
        return 1

    print(f"Hafta numaraları ({season_label(CURRENT_SEASON)})")
    incomplete = 0
    for league in UNDERSTAT_LEAGUES:
        filled, total = fill_rounds(league, CURRENT_SEASON, mapping)
        if total == 0:
            continue
        if filled == total:
            print(f"  ✓ {league:12s} {filled}/{total}")
        else:
            print(f"  ! {league:12s} {filled}/{total} maçın haftası bulunamadı")
            incomplete += 1
        time.sleep(1.0)

    if incomplete:
        print(f"\n{incomplete} ligde eksik hafta var; site o maçları "
              f"'Diğer maçlar' altında gösterir.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
