"""Understat ↔ FotMob takım kimliği köprüsü.

Neden gerekli: Understat xG veriyor ama takım logosu ve hafta numarası
vermiyor; FotMob ikisini de veriyor. İki kaynağı birleştirmek için takımların
eşleştirilmesi lazım — yani projeden bilerek uzak tuttuğum isim eşleştirmesi.

Varsayılan davranış katı: bir lig-sezonda tek bir takım bile eşleşmezse hata
fırlatılıyor ve eşleşmeyen isim yazdırılıyor; çözüm ALIASES'a bir satır
eklemek. Kısmi eşleşme sessizce kabul edilseydi bazı takımlar logosuz kalır,
daha kötüsü yanlış takımla eşleşebilirdi.

Gecelik akış `--lenient` ile çalışıyor: yeni çıkan bir takım eşleşmezse o
lig-sezon atlanıyor, mevcut eşleme korunuyor ve akış devam ediyor. Kaybedilen
şey yalnızca o takımın logosu ve hafta numarası; bunun için çalışan tahminleri
yayından kaldırmak orantısız olurdu.

Eşleştirme yalnızca görüntüleme verisi (logo, hafta) için kullanılıyor;
model tarafında hâlâ tek bir kaynağın sayısal kimlikleri geçerli.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from difflib import SequenceMatcher

import pandas as pd

from pipeline.config import DATA_DIR, LEAGUES, SEASONS, UNDERSTAT_LEAGUES, raw_path
from pipeline.sources import fotmob

CROSSWALK_PATH = DATA_DIR / "team_crosswalk.json"

# Normalizasyonun çözemediği isimler. Sol taraf Understat, sağ taraf FotMob.
ALIASES = {
    "brighton": "brighton hove albion",
    "west ham": "west ham united",
    "tottenham": "tottenham hotspur",
    "leeds": "leeds united",
    "alaves": "deportivo alaves",
    "verona": "hellas verona",
    "bayern munich": "bayern munchen",
    "rasenballsport leipzig": "rb leipzig",
    "cologne": "koln",
    "borussia m gladbach": "borussia monchengladbach",
    "paris saint germain": "paris saint germain",
    "nottingham forest": "nottingham forest",
    "wolverhampton wanderers": "wolverhampton wanderers",
}

# Bu ekler iki kaynakta tutarsız kullanılıyor, karşılaştırma öncesi atılıyor.
NOISE = re.compile(
    r"\b(fc|cf|ac|as|sc|sv|vfl|vfb|rc|ss|ssc|us|ogc|tsg|bsc|fsv|afc|calcio|club"
    r"|cd|ud|rcd|sd|1899|1846|1913|1900|04|05|09|98|1)\b"
)

MATCH_THRESHOLD = 0.72


def normalise(name: str) -> str:
    text = "".join(
        c for c in unicodedata.normalize("NFD", str(name))
        if unicodedata.category(c) != "Mn"
    ).lower()
    text = text.replace("&", " ").replace("-", " ").replace(".", " ").replace("'", " ")
    text = NOISE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return ALIASES.get(text, text)


def _similarity(left: str, right: str) -> float:
    """İki normalize isim arasındaki benzerlik.

    Understat kısa ad kullanma eğiliminde ("Luton", "Brighton", "Leeds"),
    FotMob tam adı ("Luton Town", "Brighton Hove Albion", "Leeds United").
    Bu kalıp o kadar yaygın ki tek tek alias yazmak yerine kural haline
    getirildi: biri diğerinin kelime sınırındaki öneki ise yüksek puan alır.
    Birebir eşleşmeler 1.0 ile önce yerleştiği için "Manchester" gibi
    belirsiz bir önek yanlış takımı kapamıyor.
    """
    if left == right:
        return 1.0
    short, long = sorted((left, right), key=len)
    if short and long.startswith(short + " "):
        return 0.95
    return SequenceMatcher(None, left, right).ratio()


def _pair_teams(left: dict[str, str], right: dict[str, str],
                tag: str) -> dict[str, str]:
    """İki takım kümesini 1:1 eşler. Eksik kalırsa hata fırlatır."""
    if len(left) != len(right):
        raise ValueError(
            f"{tag}: takım sayıları tutmuyor (Understat {len(left)}, FotMob {len(right)})"
        )

    scores = []
    for lid, lname in left.items():
        ln = normalise(lname)
        for rid, rname in right.items():
            rn = normalise(rname)
            scores.append((_similarity(ln, rn), lid, rid))
    # Yüksek puandan başlanıyor: birebir eşleşmeler önce yerleşiyor, böylece
    # "Manchester" gibi belirsiz bir önek yanlış takıma kapılanamıyor.
    scores.sort(key=lambda item: item[0], reverse=True)

    mapping: dict[str, str] = {}
    used: set[str] = set()
    for score, lid, rid in scores:
        if score < MATCH_THRESHOLD or lid in mapping or rid in used:
            continue
        mapping[lid] = rid
        used.add(rid)

    unmatched = [left[lid] for lid in left if lid not in mapping]
    if unmatched:
        spare = [right[rid] for rid in right if rid not in used]
        raise ValueError(
            f"{tag}: eşleşmeyen takım(lar) {unmatched}. "
            f"FotMob tarafında boşta kalanlar: {spare}. "
            f"crosswalk.ALIASES'a karşılığını ekle."
        )
    return mapping


def build(verbose: bool = True, strict: bool = True) -> tuple[dict, list[str]]:
    """Bütün lig-sezonları tarayıp Understat id → FotMob id haritası kurar.

    strict=True (elle çalıştırma): eşleşmeyen takım varsa hata fırlatır, çünkü
    o takımın karşılığını ALIASES'a eklemek gerekir.

    strict=False (gecelik akış): eşleşmeyen lig-sezonu atlar ve uyarı döndürür.
    Eşleşememenin tek sonucu o takımın logosuz kalması ve maçlarının hafta
    numarasını alamamasıdır — ikisi de kozmetik. Bütün pipeline'ı bunun için
    durdurmak, çalışan tahminleri de yayından kaldırmak olurdu.
    """
    crosswalk: dict[str, dict] = dict(load())
    warnings: list[str] = []

    for league in UNDERSTAT_LEAGUES:
        if not LEAGUES[league].get("fotmob"):
            continue
        for season in SEASONS:
            path = raw_path(league, season)
            if not path.exists():
                continue
            raw = pd.read_parquet(path)
            if raw.empty or not str(raw["home_id"].iat[0]).startswith("us"):
                continue

            understat_teams: dict[str, str] = {}
            for row in raw.itertuples(index=False):
                understat_teams[row.home_id] = row.home_team
                understat_teams[row.away_id] = row.away_team

            matches = fotmob.fetch_matches(league, season)
            if not matches:
                continue
            fotmob_teams, _ = fotmob.teams_and_rounds(matches)

            tag = f"{league} {season}"
            try:
                mapping = _pair_teams(understat_teams, fotmob_teams, tag)
            except ValueError as exc:
                if strict:
                    raise
                warnings.append(str(exc))
                if verbose:
                    print(f"  ! {tag:24s} atlandı — {exc}")
                time.sleep(1.0)
                continue

            for understat_id, fotmob_id in mapping.items():
                crosswalk[understat_id] = {
                    "fotmob_id": fotmob_id,
                    "understat_name": understat_teams[understat_id],
                    "fotmob_name": fotmob_teams[fotmob_id],
                }
            if verbose:
                print(f"  ✓ {tag:24s} {len(mapping)} takım eşleşti")
            time.sleep(1.0)

    return crosswalk, warnings


def load() -> dict:
    if not CROSSWALK_PATH.exists():
        return {}
    return json.loads(CROSSWALK_PATH.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Understat ↔ FotMob takım eşlemesi")
    parser.add_argument(
        "--lenient", action="store_true",
        help="eşleşmeyen takımda hata verme, o lig-sezonu atla (gecelik akış için)",
    )
    args = parser.parse_args()

    print("Understat ↔ FotMob takım eşlemesi kuruluyor")
    try:
        mapping, warnings = build(strict=not args.lenient)
    except ValueError as exc:
        print(f"\n✗ {exc}")
        return 1

    CROSSWALK_PATH.parent.mkdir(parents=True, exist_ok=True)
    CROSSWALK_PATH.write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(f"\n{len(mapping)} takım → {CROSSWALK_PATH}")
    if warnings:
        print(f"{len(warnings)} lig-sezon eşleşmedi; o takımlar logosuz ve "
              f"haftasız kalır. Düzeltmek için ALIASES'a ekleyip --lenient'sız çalıştır.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
