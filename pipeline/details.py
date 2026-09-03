"""Maç detayları: xG, kadro değeri, ilk 11 ve teknik direktör.

Lig fikstür ucu yalnızca skor veriyor. `matchDetails` ucu ise maç başına tek
istekle şunları birden veriyor:

    expected_goals            → xG'si olmayan 15 yarışma için (ölçüldü: +%0.52)
    totalStarterMarketValue   → sahaya çıkan kadronun piyasa değeri
    averageStarterAge         → ilk 11 yaş ortalaması
    coach                     → teknik direktör kimliği (değişim tespiti)
    unavailable               → sakat/cezalı oyuncular, PİYASA DEĞERLERİYLE
    infoBox.Stadium           → stadyum koordinatı, kapasite (hava durumu için)
    infoBox.Attendance        → seyirci sayısı
    infoBox.Referee           → hakem

Yani "kadro değeri", "ilk 11 gücü" ve "teknik direktör değişimi" için ayrı
bir kaynak (Transfermarkt) gerekmiyor; hepsi aynı istekten çıkıyor.

Eksik oyuncuların DEĞERİ ayrıca önemli: sakatlık daha önce "kaç oyuncu
eksik" olarak ölçülüp elenmişti (+%0.01), ama o yanlış ölçüydü — yıldız
oyuncunun yokluğuyla üçüncü kalecininki aynı sayılıyordu.

DİKKAT — sızıntı: `attendance` ve `referee` maç ANINDA belli oluyor, 60 gün
sonraki bir maç için bilinmiyor. Bunlar doğrudan feature olamaz; yalnızca
takımın geçmiş ortalaması gibi maç öncesi bilinen türevleri kullanılabilir.
Stadyum koordinatı ve kapasite ise her zaman bilinir, onlarda sorun yok.

Bu adım pahalı: 42.050 oynanmış maç var. O yüzden
  · sonuç maç başına önbelleğe yazılıyor ve bir daha istenmiyor,
  · her çalıştırma bir bütçeyle sınırlı (`--budget`),
  · önbellek repoda duruyor, yani iş birden çok çalıştırmaya bölünebiliyor.

Biten maçın detayı bir daha değişmiyor; önbellek kalıcı olarak geçerli.

Kimlik eşleşmesi: fikstür ucundan gelen satırlar `ingest.canonicalise` ile
aynı kanonik `match_id`'ye çevriliyor — ham veriyle birebir aynı kod yolu,
dolayısıyla eşleşme kaymıyor.
"""

from __future__ import annotations

import argparse
import sys
import time

import pandas as pd
import requests

from pipeline.config import DATA_DIR, LEAGUES, raw_path, seasons_for
from pipeline.ingest import canonicalise
from pipeline.sources import fotmob

DETAILS_DIR = DATA_DIR / "details"
DETAIL_URL = "https://www.fotmob.com/api/data/matchDetails"

# İstekler arası bekleme. Kaynağa saygı: 42 bin istek atılacak.
SLEEP = 0.5
DEFAULT_BUDGET = 4000

COLUMNS = [
    "match_id", "fotmob_id",
    "home_xg", "away_xg",
    "home_value", "away_value",
    "home_age", "away_age",
    "home_coach", "away_coach",
    "home_out_n", "away_out_n",
    "home_out_value", "away_out_value",
    "lat", "lon", "capacity", "attendance", "referee",
]


def cache_path(league: str, season: str):
    return DETAILS_DIR / f"{league}_{season}.parquet"


def load_cache(league: str, season: str) -> pd.DataFrame:
    path = cache_path(league, season)
    if not path.exists():
        return pd.DataFrame(columns=COLUMNS)
    return pd.read_parquet(path)


def _number(value) -> float | None:
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _xg(content: dict) -> tuple[float | None, float | None]:
    # Her kademede `or {}` şart: FotMob eksik bölümü anahtarsız değil, anahtar
    # var ama değeri `null` olarak veriyor. `.get("All", {})` o durumda
    # varsayılanı değil None'ı döndürüyor ve zincir kırılıyor.
    periods = ((content.get("stats") or {}).get("Periods") or {})
    groups = ((periods.get("All") or {}).get("stats") or [])
    for group in groups:
        for stat in group.get("stats", []):
            if stat.get("key") != "expected_goals":
                continue
            pair = stat.get("stats") or []
            if len(pair) == 2 and pair[0] is not None and pair[1] is not None:
                return _number(pair[0]), _number(pair[1])
    return None, None


def _side(team: dict | None) -> dict:
    if not team:
        return {}
    coach = team.get("coach") or {}
    if isinstance(coach, list):
        coach = coach[0] if coach else {}
    out = team.get("unavailable") or []
    out_value = sum(_number(p.get("marketValue")) or 0.0 for p in out)
    return {
        "value": _number(team.get("totalStarterMarketValue")),
        "age": _number(team.get("averageStarterAge")),
        "coach": str(coach.get("id")) if coach.get("id") else None,
        "out_n": float(len(out)),
        "out_value": out_value,
    }


def _venue(content: dict) -> dict:
    info = (content.get("matchFacts") or {}).get("infoBox") or {}
    stadium = info.get("Stadium") or {}
    referee = info.get("Referee") or {}
    if not isinstance(stadium, dict):
        stadium = {}
    return {
        "lat": _number(stadium.get("lat")),
        "lon": _number(stadium.get("long")),
        "capacity": _number(stadium.get("capacity")),
        "attendance": _number(info.get("Attendance")),
        "referee": referee.get("text") if isinstance(referee, dict) else None,
    }


def fetch_detail(fotmob_id: str) -> dict | None:
    try:
        response = requests.get(DETAIL_URL, params={"matchId": fotmob_id},
                                headers=fotmob.HEADERS, timeout=30)
    except Exception:
        return None
    if response.status_code != 200:
        return None
    try:
        content = response.json().get("content") or {}
    except ValueError:
        return None

    # Tek bir bozuk maç 5.000 isteklik işi öldürmemeli: ayrıştırma hatası
    # o maçı atlamakla sonuçlanır, işi durdurmakla değil.
    try:
        home_xg, away_xg = _xg(content)
        lineup = content.get("lineup") or {}
        home = _side(lineup.get("homeTeam"))
        away = _side(lineup.get("awayTeam"))
        venue = _venue(content)
    except Exception:
        return None
    return {
        "home_xg": home_xg, "away_xg": away_xg,
        "home_value": home.get("value"), "away_value": away.get("value"),
        "home_age": home.get("age"), "away_age": away.get("age"),
        "home_coach": home.get("coach"), "away_coach": away.get("coach"),
        "home_out_n": home.get("out_n"), "away_out_n": away.get("out_n"),
        "home_out_value": home.get("out_value"),
        "away_out_value": away.get("out_value"),
        **venue,
    }


def fixture_ids(league: str, season: str) -> pd.DataFrame:
    """Takım çifti + tarih → FotMob maç kimliği.

    match_id üzerinden eşleştirilemiyor: arşiv sezonları (2024/25 ve öncesi)
    kanonik şema gelmeden önce yazıldıkları için kaynağın kendi kimliğini
    taşıyor ("us23065"), canlı sezonlar ise yeni şemayı
    ("Bundesliga-2025_2026-us117-us136"). Aynı veri setinde iki biçim yan
    yana duruyor ve bu adım ikisiyle de çalışmak zorunda.

    Takım kimlikleri her iki biçimde de kanonik, o yüzden eşleşme (ev,
    deplasman) çifti üzerinden yapılıyor; aynı çift sezon içinde birden çok
    kez oynayabildiği için (bölünmüş formatlı ligler) tarih de taşınıyor.
    """
    df = fotmob.fetch_league_season(league, season)
    if df.empty:
        return df
    df = df.copy()
    df["fotmob_id"] = df["match_id"].str.removeprefix("fm")
    df = canonicalise(df, league)
    df = df[df["is_result"] == True]  # noqa: E712
    return df[["home_id", "away_id", "datetime", "fotmob_id"]]


def process(league: str, season: str, budget: int) -> tuple[int, int]:
    """Bir lig-sezonu tamamlar. (harcanan istek, kalan eksik) döner."""
    path = raw_path(league, season)
    if not path.exists():
        return 0, 0
    ours = pd.read_parquet(path)
    ours = ours[ours["is_result"] == True]  # noqa: E712
    if ours.empty:
        return 0, 0

    cache = load_cache(league, season)
    have = set(cache["match_id"]) if not cache.empty else set()
    todo = ours[~ours["match_id"].isin(have)]
    if todo.empty:
        return 0, 0
    missing = list(todo["match_id"])

    mapping = fixture_ids(league, season)
    spent = 1                                   # fikstür isteği de sayılıyor
    if mapping.empty:
        return spent, len(missing)

    # (ev, deplasman) → [(tarih, fotmob_id)]. Aynı çift birden çok kez
    # oynadıysa tarihi en yakın olan seçiliyor.
    lookup: dict[tuple[str, str], list] = {}
    for row in mapping.itertuples(index=False):
        lookup.setdefault((row.home_id, row.away_id), []).append(
            (pd.Timestamp(row.datetime), row.fotmob_id))

    rows = []
    for row in todo.itertuples(index=False):
        if spent >= budget:
            break
        match_id = row.match_id
        options = lookup.get((row.home_id, row.away_id))
        if not options:
            continue
        when = pd.Timestamp(row.datetime)
        fotmob_id = min(options, key=lambda o: abs(o[0] - when))[1]
        detail = fetch_detail(fotmob_id)
        spent += 1
        time.sleep(SLEEP)
        if detail is None:
            continue
        rows.append({"match_id": match_id, "fotmob_id": fotmob_id, **detail})

    if rows:
        merged = pd.concat([cache, pd.DataFrame(rows)], ignore_index=True)
        merged = merged.drop_duplicates("match_id", keep="last")
        DETAILS_DIR.mkdir(parents=True, exist_ok=True)
        merged.to_parquet(cache_path(league, season), index=False)

    remaining = len(missing) - len(rows)
    print(f"  {league:12s} {season}  +{len(rows):4d} kayıt, {remaining:4d} eksik",
          flush=True)
    return spent, remaining


def load_all() -> pd.DataFrame:
    """Bütün önbellek tek tabloda."""
    if not DETAILS_DIR.exists():
        return pd.DataFrame(columns=COLUMNS)
    frames = [pd.read_parquet(p) for p in sorted(DETAILS_DIR.glob("*.parquet"))]
    if not frames:
        return pd.DataFrame(columns=COLUMNS)
    return pd.concat(frames, ignore_index=True).drop_duplicates("match_id")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=int, default=DEFAULT_BUDGET,
                        help="bu çalıştırmadaki azami istek sayısı")
    parser.add_argument("--leagues", nargs="*", default=None,
                        help="yalnızca bu yarışmalar")
    parser.add_argument("--xg-first", action="store_true",
                        help="önce xG'si olmayan yarışmalar (ölçülmüş kazanç orada)")
    # FotMob'un alan kapsaması eskiye gittikçe zayıflıyor: xG 2022/23'ten,
    # kadro piyasa değeri 2024/25'ten itibaren dolu; teknik direktör
    # 2016/17'ye kadar var. Eski sezonları taramak istek harcayıp boş satır
    # üretiyor, o yüzden varsayılan bir kesme noktası var.
    parser.add_argument("--since", default="2022_2023",
                        help="bu sezondan eskisi taranmasın (boş: hepsi)")
    args = parser.parse_args()

    wanted = args.leagues or list(LEAGUES)
    if args.xg_first:
        def has_xg(league: str) -> bool:
            return bool(LEAGUES[league].get("understat"))
        wanted = ([l for l in wanted if not has_xg(l)]
                  + [l for l in wanted if has_xg(l)])

    spent = 0
    left = 0
    for league in wanted:
        # Yeniden eskiye: hem alan kapsaması yeni sezonlarda daha iyi hem de
        # iş yarıda kalırsa elde en işe yarar veri kalmış olur.
        for season in sorted(seasons_for(league), reverse=True):
            if args.since and season < args.since:
                continue
            if spent >= args.budget:
                left += 1
                continue
            used, remaining = process(league, season, args.budget - spent)
            spent += used
            left += remaining

    print(f"\n{spent} istek harcandı, {left} maç eksik kaldı.")
    if left:
        print("Kalanı tamamlamak için bu adımı tekrar çalıştırın.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
