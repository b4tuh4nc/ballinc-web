"""Geçmiş kapanış oranları (football-data.co.uk) — modelin piyasaya karşı
dürüst ölçümü ve harman denemeleri için.

Neden gerekli: canlı oran servisi (the-odds-api) yalnızca yaklaşan maçları
veriyor, geçmişi ücretli. Elimizdeki sonuçlanmış + oranlı maç sayısı 54'te
kalmıştı; o örneklemde harman ağırlığı kestirmek gürültü uydurmak olurdu.
football-data.co.uk ise on yılı aşkın kapanış oranını ücretsiz veriyor.

Kapanış oranı bilerek seçildi: bahisçinin maç başlarkenki son fiyatı, yani
piyasanın bütün bilgiyi (kadro, sakatlık, hava) sindirdikten sonraki görüşü.
Açılış oranı daha zayıf bir rakip olurdu ve modeli haksız yere iyi gösterirdi.

Sızıntı yok: kapanış oranı ilk vuruştan ÖNCE oluşuyor, maç sonucunu içermiyor.

Not: site Türkiye'den erişilemiyor (bağlantı zaman aşımı), GitHub Actions
koşucusundan erişilebiliyor. Bu yüzden indirme CI'da yapılıp çıktı parquet
olarak repoya yazılıyor.
"""

from __future__ import annotations

import io
import sys
from difflib import SequenceMatcher

import pandas as pd
import requests

from pipeline.config import DATA_DIR, SEASONS, raw_path
from pipeline.crosswalk import normalise

HIST_PATH = DATA_DIR / "hist_odds.parquet"

MAIN_URL = "https://www.football-data.co.uk/mmz4281/{code}/{div}.csv"
EXTRA_URL = "https://www.football-data.co.uk/new/{div}.csv"

# Sezon başına ayrı dosya verilen ligler.
MAIN_DIVISIONS = {
    "EPL": "E0",
    "La_Liga": "SP1",
    "Serie_A": "I1",
    "Bundesliga": "D1",
    "Ligue_1": "F1",
    "NED": "N1",
    "POR": "P1",
    "BEL": "B1",
    "TSL": "T1",
    "GRE": "G1",
    "SCO": "SC0",
}

# Bütün sezonları tek dosyada veren ligler. Çekya ve Hırvatistan bu kaynakta
# hiç yok (dosya adları tarandı, hepsi 404) — canlı oran sağlayıcısında da
# yoklar, yani o iki lig kalıcı olarak piyasa kıyası dışında.
EXTRA_DIVISIONS = {
    "AUT": "AUT",
    "DEN": "DNK",
    "POL": "POL",
    "SUI": "SWZ",
    "CZE": "CZE",
    "CRO": "CRO",
}

# Oran sütunu tercih sırası. Önce bütün bahisçilerin KAPANIŞ ortalaması
# (piyasa konsensüsü), sonra Pinnacle kapanış (en keskin tek bahisçi), sonra
# ortalama/açılış alternatifleri. Eski sezonlarda AvgC yok, BbAv var.
ODDS_COLUMNS = [
    ("AvgCH", "AvgCD", "AvgCA", "kapanis_ortalama"),
    ("PSCH", "PSCD", "PSCA", "pinnacle_kapanis"),
    ("B365CH", "B365CD", "B365CA", "b365_kapanis"),
    ("AvgH", "AvgD", "AvgA", "ortalama"),
    ("BbAvH", "BbAvD", "BbAvA", "bb_ortalama"),
    ("PSH", "PSD", "PSA", "pinnacle"),
    ("B365H", "B365D", "B365A", "b365"),
]

MATCH_THRESHOLD = 0.72


def _season_code(season: str) -> str:
    """2014_2015 → 1415."""
    start, end = season.split("_")
    return start[2:] + end[2:]


def _fetch(url: str) -> pd.DataFrame | None:
    try:
        response = requests.get(url, timeout=40)
    except Exception as exc:
        print(f"  ! {url} ({type(exc).__name__})")
        return None
    if response.status_code != 200 or not response.content:
        return None
    # Dosyalar bazen bozuk satır içeriyor; hatalı satır atlanıyor.
    return pd.read_csv(io.BytesIO(response.content), encoding="latin-1",
                       on_bad_lines="skip")


def _pick_odds(df: pd.DataFrame) -> tuple[pd.DataFrame, str] | None:
    """İlk bulunan tam oran üçlüsünü seçer."""
    for home, draw, away, label in ODDS_COLUMNS:
        if {home, draw, away} <= set(df.columns):
            picked = df[[home, draw, away]].apply(pd.to_numeric, errors="coerce")
            picked.columns = ["odds_h", "odds_d", "odds_a"]
            if picked.notna().all(axis=1).sum() == 0:
                continue
            return picked, label
    return None


def _rows(df: pd.DataFrame, home_col: str, away_col: str) -> pd.DataFrame | None:
    """CSV'yi ortak biçime indirger: tarih, iki takım adı, üç oran."""
    if home_col not in df.columns or "Date" not in df.columns:
        return None
    chosen = _pick_odds(df)
    if not chosen:
        return None
    odds, label = chosen

    out = pd.DataFrame({
        "date": pd.to_datetime(df["Date"], dayfirst=True, errors="coerce"),
        "home_raw": df[home_col].astype(str).str.strip(),
        "away_raw": df[away_col].astype(str).str.strip(),
    })
    out = pd.concat([out, odds], axis=1)
    out["source"] = label
    return out.dropna(subset=["date", "odds_h", "odds_d", "odds_a"])


def _our_matches(league: str, season: str) -> pd.DataFrame | None:
    path = raw_path(league, season)
    if not path.exists():
        return None
    df = pd.read_parquet(path)
    keep = ["match_id", "datetime", "home_id", "away_id", "home_team", "away_team"]
    return df[keep].copy()


def _resolve(ours: pd.DataFrame, names: set[str]) -> dict[str, str]:
    """Sağlayıcı takım adı → kanonik kimlik.

    Eşleştirme lig-sezon içinde yapılıyor: aynı anda yalnızca ~20 aday var,
    bu da "Man United" / "Man City" gibi tuzakları ciddi ölçüde azaltıyor.
    """
    canonical: dict[str, str] = {}
    for row in ours.itertuples(index=False):
        canonical[normalise(row.home_team)] = row.home_id
        canonical[normalise(row.away_team)] = row.away_id

    mapping: dict[str, str] = {}
    for name in names:
        target = normalise(name)
        if target in canonical:
            mapping[name] = canonical[target]
            continue
        best_id, best_score = None, 0.0
        for candidate, team_id in canonical.items():
            score = SequenceMatcher(None, candidate, target).ratio()
            short, long = sorted((candidate, target), key=len)
            if short and (long.startswith(short + " ") or long.endswith(" " + short)):
                score = max(score, 0.93)
            if score > best_score:
                best_id, best_score = team_id, score
        if best_score >= MATCH_THRESHOLD:
            mapping[name] = best_id
    return mapping


def _join(rows: pd.DataFrame, ours: pd.DataFrame) -> pd.DataFrame:
    """Oran satırlarını bizim match_id'lerimize bağlar.

    Eşleşme (ev, deplasman) üzerinden; aynı çift sezon içinde birden çok kez
    oynanabildiği için (bölünmüş formatlı ligler) tarihe en yakın olan
    seçiliyor. Tarih tek başına anahtar değil: sağlayıcının tarihi yerel,
    bizimki UTC ve maçlar erteleniyor.
    """
    names = set(rows["home_raw"]) | set(rows["away_raw"])
    mapping = _resolve(ours, names)
    rows = rows.assign(
        home_id=rows["home_raw"].map(mapping),
        away_id=rows["away_raw"].map(mapping),
    ).dropna(subset=["home_id", "away_id"])
    if rows.empty:
        return rows

    ours = ours.copy()
    ours["datetime"] = pd.to_datetime(ours["datetime"])
    merged = rows.merge(ours, on=["home_id", "away_id"], how="inner")
    if merged.empty:
        return merged

    merged["gap"] = (merged["datetime"] - merged["date"]).abs()
    # Aynı eşleşmenin birden çok tarihi varsa en yakını kalır.
    merged = (merged.sort_values("gap")
                    .drop_duplicates(subset=["match_id"], keep="first"))
    # Ay farkı varsa bu bir eşleşme değil, tesadüf.
    merged = merged[merged["gap"] <= pd.Timedelta(days=20)]
    return merged[["match_id", "odds_h", "odds_d", "odds_a", "source"]]


def collect() -> pd.DataFrame:
    frames: list[pd.DataFrame] = []

    for league, div in MAIN_DIVISIONS.items():
        found = 0
        for season in SEASONS:
            ours = _our_matches(league, season)
            if ours is None or ours.empty:
                continue
            df = _fetch(MAIN_URL.format(code=_season_code(season), div=div))
            if df is None:
                continue
            rows = _rows(df, "HomeTeam", "AwayTeam")
            if rows is None or rows.empty:
                continue
            joined = _join(rows, ours)
            if not joined.empty:
                joined = joined.assign(league=league, season=season)
                frames.append(joined)
                found += len(joined)
        print(f"  {league:12s} {found:5d} maç")

    for league, div in EXTRA_DIVISIONS.items():
        df = _fetch(EXTRA_URL.format(div=div))
        if df is None:
            print(f"  {league:12s}     0 maç (dosya alınamadı)")
            continue
        rows = _rows(df, "Home", "Away")
        if rows is None or rows.empty:
            print(f"  {league:12s}     0 maç (oran sütunu yok)")
            continue
        found = 0
        for season in SEASONS:
            ours = _our_matches(league, season)
            if ours is None or ours.empty:
                continue
            # Tek dosyada bütün sezonlar var; bizim sezon aralığımıza kırpıyoruz.
            start = pd.Timestamp(f"{season.split('_')[0]}-06-01")
            end = pd.Timestamp(f"{season.split('_')[1]}-08-01")
            window = rows[(rows["date"] >= start) & (rows["date"] < end)]
            if window.empty:
                continue
            joined = _join(window, ours)
            if not joined.empty:
                joined = joined.assign(league=league, season=season)
                frames.append(joined)
                found += len(joined)
        print(f"  {league:12s} {found:5d} maç")

    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True).drop_duplicates("match_id")


def load() -> pd.DataFrame:
    if not HIST_PATH.exists():
        return pd.DataFrame()
    return pd.read_parquet(HIST_PATH)


def main() -> int:
    print("Geçmiş kapanış oranları indiriliyor...")
    table = collect()
    if table.empty:
        print("Hiç oran alınamadı.")
        return 1

    HIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    table.to_parquet(HIST_PATH, index=False)
    print(f"\n{len(table)} maçlık geçmiş oran → {HIST_PATH}")
    print(table["source"].value_counts().to_string())
    return 0


if __name__ == "__main__":
    sys.exit(main())
