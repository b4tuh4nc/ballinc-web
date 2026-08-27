"""Tek doğruluk kaynağı: sezonlar, ligler, yollar.

Yeni sezona geçmek için sadece CURRENT_SEASON ve SEASONS güncellenir.
Eski projede sezon bilgisi 8 ayrı dosyada hardcoded'dı; buradaki tek amaç
bunun bir daha olmaması.
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
MODELS_DIR = BASE_DIR / "models"
WEB_DIR = BASE_DIR / "web"
WEB_DATA_DIR = WEB_DIR / "data"
PREDICTIONS_DB = DATA_DIR / "predictions.sqlite"

# ─── Sezonlar ────────────────────────────────────────────────────────────────
CURRENT_SEASON = "2026_2027"
SEASONS = ["2023_2024", "2024_2025", "2025_2026", "2026_2027"]

# ─── Ligler ──────────────────────────────────────────────────────────────────
# understat: getLeagueData slug'ı. La Liga'nınki küçük "l" ile "La_liga" —
#            eski sistemde "La_Liga" denendiği için lig hiç çekilemiyordu.
# sofascore: unique-tournament id (sadece Understat kapsamı dışındaki ligler)
# teams:     sezondaki takım sayısı; validate.py bunu zorunlu kılar
LEAGUES = {
    "EPL": {
        "name": "Premier Lig",
        "flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
        "understat": "EPL",
        "teams": 20,
    },
    "La_Liga": {
        "name": "La Liga",
        "flag": "🇪🇸",
        "understat": "La_liga",
        "teams": 20,
    },
    "Serie_A": {
        "name": "Serie A",
        "flag": "🇮🇹",
        "understat": "Serie_A",
        "teams": 20,
    },
    "Bundesliga": {
        "name": "Bundesliga",
        "flag": "🇩🇪",
        "understat": "Bundesliga",
        "teams": 18,
    },
    "Ligue_1": {
        "name": "Ligue 1",
        "flag": "🇫🇷",
        "understat": "Ligue_1",
        "teams": 18,
    },
    "TSL": {
        "name": "Süper Lig",
        "flag": "🇹🇷",
        "sofascore": 52,
        "teams": 18,
        "has_xg": False,  # SofaScore event listesinde xG yok
    },
}

UNDERSTAT_LEAGUES = [k for k, v in LEAGUES.items() if v.get("understat")]
SOFASCORE_LEAGUES = [k for k, v in LEAGUES.items() if v.get("sofascore")]

# ─── Sızıntı kara listesi ────────────────────────────────────────────────────
# Understat'ın "forecast" alanı maçın KENDİ xG'sinden hesaplanıyor, yani
# maç oynanmadan bilinemez. Feature olarak kullanılırsa model sahte bir
# doğrulukla parlar. Asla ham veriye bile yazılmıyor.
LEAK_FIELDS = frozenset({"forecast"})

# ─── Zaman ───────────────────────────────────────────────────────────────────
# Understat datetime'ları UTC kabul ediliyor; validate.py bunu doğruluyor.
DISPLAY_TZ = "Europe/Istanbul"

# ─── Tahmin penceresi ────────────────────────────────────────────────────────
# Bundan uzaktaki fikstürlerde saatler placeholder ve form verisi anlamsız.
PREDICT_WINDOW_DAYS = 14

# Poisson skor matrisi kenar uzunluğu (0..10 gol)
MAX_GOALS = 11


def understat_year(season: str) -> str:
    """'2026_2027' -> '2026' (Understat sezonu başlangıç yılıyla adlandırır)."""
    return season.split("_")[0]


def season_label(season: str) -> str:
    """'2026_2027' -> '26/27'"""
    start, end = season.split("_")
    return f"{start[2:]}/{end[2:]}"


def raw_path(league: str, season: str) -> Path:
    return RAW_DIR / f"{league}_{season}.parquet"
