"""Veri bütünlük kontrolleri. CI'da bloklayıcıdır.

Eski sistemin en pahalı özelliği, bozulmanın sessiz olmasıydı: EPL dosyasında
417 maç ve 25 takım vardı, kimse fark etmedi. Buradaki her kontrol o
hatalardan birine karşılık geliyor ve başarısız olursa pipeline durur —
site eski, çalışan JSON'uyla ayakta kalır.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field

import pandas as pd

from pipeline.config import (
    CURRENT_SEASON,
    LEAGUES,
    LEAK_FIELDS,
    SEASONS,
    TEAM_COUNT_RANGE,
    raw_path,
    season_label,
    league_format,
    seasons_for,
)


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    @property
    def ok(self) -> bool:
        return not self.errors


def expected_matches(teams: int) -> int:
    """Çift devreli lig: her takım diğerleriyle ikişer kez."""
    return teams * (teams - 1)


def check_league_season(df: pd.DataFrame, league: str, season: str, rep: Report) -> None:
    tag = f"{league} {season_label(season)}"
    cfg = LEAGUES[league]
    is_current = season == CURRENT_SEASON

    # 1. Sızıntılı alan
    leaked = LEAK_FIELDS & set(df.columns)
    if leaked:
        rep.error(f"{tag}: sızıntılı alan veride: {sorted(leaked)}")

    # 2. Takım sayısı veriden türetiliyor, config'den değil.
    #    Sabit bir sayı yanlış olduğunda hem ingest veriyi kırpıyor hem de
    #    bu kontrol aynı yanlış sabitle "geçti" diyordu.
    teams = set(df["home_id"]) | set(df["away_id"])
    lo, hi = TEAM_COUNT_RANGE
    if not (lo <= len(teams) <= hi):
        rep.error(f"{tag}: {len(teams)} takım — beklenen aralık {lo}-{hi} dışında")

    fmt = league_format(league)

    # 3. Yapısal tutarlılık: çift devreli ligde maç sayısı takım sayısından
    #    tek başına belirlenir. Fazla maç = lig dışı maç sızmış; eksik maç =
    #    çekim yarım kalmış.
    #    tek başına belirlenir. Split ve kupa formatlarında böyle bir formül
    #    yok: şampiyonluk grubu maç sayısını değiştiriyor, kupada takımlar
    #    eşit sayıda maç bile oynamıyor.
    if fmt == "double":
        want = expected_matches(len(teams))
        if len(df) != want:
            msg = f"{tag}: {len(teams)} takım için {want} maç olmalı, {len(df)} var"
            if is_current and len(df) < want:
                rep.warn(msg + " (fikstür henüz tamamlanmamış olabilir)")
            else:
                rep.error(msg)

    # 4. Takım kimliği ↔ isim 1:1 olmalı
    pairs = pd.concat([
        df[["home_id", "home_team"]].rename(columns={"home_id": "id", "home_team": "name"}),
        df[["away_id", "away_team"]].rename(columns={"away_id": "id", "away_team": "name"}),
    ]).drop_duplicates()
    for col, other in (("id", "name"), ("name", "id")):
        clash = pairs.groupby(col)[other].nunique()
        bad = clash[clash > 1]
        if len(bad):
            rep.error(f"{tag}: {col} birden fazla {other} ile eşleşiyor: {list(bad.index)}")

    # 5. Kopya maç
    dup_id = df["match_id"].duplicated().sum()
    if dup_id:
        rep.error(f"{tag}: {dup_id} kopya match_id")
    if fmt == "double":
        # Split formatta aynı eşleşme aynı sahada tekrar oynanıyor, kupada
        # eleme turları iki maçlı. İkisinde de bu bir hata değil.
        dup_fx = df.duplicated(subset=["home_id", "away_id"]).sum()
        if dup_fx:
            rep.error(f"{tag}: {dup_fx} kopya fikstür (aynı ev-deplasman eşleşmesi)")

    # 6. Her takım eşit sayıda ev/deplasman maçı oynamalı
    counts = df["home_id"].value_counts()
    if fmt == "double" and len(counts) and not is_current:
        if counts.nunique() > 1:
            rep.error(
                f"{tag}: takımların ev maçı sayıları eşit değil "
                f"({counts.min()}–{counts.max()})"
            )
        elif len(teams) and counts.iat[0] != len(teams) - 1:
            rep.error(
                f"{tag}: her takım {len(teams) - 1} ev maçı oynamalı, "
                f"{counts.iat[0]} oynamış"
            )

    # 7. Skor tutarlılığı
    played = df[df["is_result"]]
    if played[["home_goals", "away_goals"]].isna().any().any():
        rep.error(f"{tag}: oynanmış maçlarda eksik skor var")
    unplayed = df[~df["is_result"]]
    if unplayed[["home_goals", "away_goals"]].notna().any().any():
        rep.error(f"{tag}: oynanmamış maçta skor var")

    # 8. xG kapsamı
    if cfg.get("has_xg", True) and len(played):
        missing = int((~played["has_xg"]).sum())
        if missing:
            rep.warn(f"{tag}: {missing} oynanmış maçta xG yok")

    # 9. Tarih aralığı sezonla uyumlu mu
    start_year = int(season.split("_")[0])
    earliest = pd.Timestamp(f"{start_year}-06-01")
    latest = pd.Timestamp(f"{start_year + 1}-08-31")
    out = df[(df["datetime"] < earliest) | (df["datetime"] > latest)]
    if len(out):
        rep.error(f"{tag}: {len(out)} maç sezon tarih aralığı dışında")


def check_timezone(frames: dict[tuple[str, str], pd.DataFrame], rep: Report) -> None:
    """Understat saatlerinin UTC olduğunu doğrular.

    İngiltere'de klasik cumartesi kick-off'u yerel saatle 15:00. Saatler UTC
    ise bu, yaz saatinde (BST) 14:00, kışın (GMT) 15:00 olarak görünmeli.
    Ayrım kaybolursa kaynak saat dilimini değiştirmiş demektir ve sitedeki
    bütün maç saatleri bir saat kayar.
    """
    epl = [df for (lg, _), df in frames.items() if lg == "EPL"]
    if not epl:
        return
    df = pd.concat(epl)
    sat = df[(df["datetime"].dt.dayofweek == 5)].copy()
    sat["hour"] = sat["datetime"].dt.hour
    sat["month"] = sat["datetime"].dt.month
    sat = sat[sat["hour"].isin([14, 15])]
    if len(sat) < 20:
        return

    bst = sat[sat["month"].isin([4, 8, 9, 10])]["hour"]
    gmt = sat[sat["month"].isin([11, 12, 1, 2])]["hour"]
    if len(bst) < 5 or len(gmt) < 5:
        return

    if not (bst.mode().iat[0] == 14 and gmt.mode().iat[0] == 15):
        rep.error(
            "Understat saat dilimi beklenenden farklı: yaz/kış kick-off ayrımı "
            f"bozuk (BST modu {bst.mode().iat[0]}, GMT modu {gmt.mode().iat[0]}). "
            "Saatlerin UTC olduğu varsayımı doğrulanamadı."
        )


def main() -> int:
    rep = Report()
    frames: dict[tuple[str, str], pd.DataFrame] = {}
    missing = 0

    for league in LEAGUES:
        for season in seasons_for(league):
            path = raw_path(league, season)
            if not path.exists():
                missing += 1
                continue
            df = pd.read_parquet(path)
            frames[(league, season)] = df
            check_league_season(df, league, season, rep)

    if not frames:
        print("Hiç ham veri yok. Önce `python -m pipeline.ingest` çalıştır.")
        return 1

    check_timezone(frames, rep)

    print(f"{len(frames)} lig-sezon kontrol edildi ({missing} dosya yok).")
    for w in rep.warnings:
        print(f"  ! {w}")
    for e in rep.errors:
        print(f"  ✗ {e}")

    if rep.ok:
        total = sum(len(d) for d in frames.values())
        print(f"\nTüm kontroller geçti. Toplam {total} maç.")
        return 0
    print(f"\n{len(rep.errors)} hata. Pipeline durduruldu.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
