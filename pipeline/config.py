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
# fotmob:    lig id'si (Understat kapsamı dışındaki ligler)
#
# Takım sayısı BİLEREK yazılmıyor. Sabit bir sayı yanlış olduğunda hem veriyi
# kırpıyor hem de doğrulamayı kandırıyor: Süper Lig 2023/24'te 20, 2024/25'te
# 19, sonra 18 takımlıydı; config'de "18" yazdığı için ingest gerçek lig
# maçlarını atıyor, validate de aynı yanlış sabiti kullandığı için "geçti"
# diyordu. Artık takım sayısı veriden türetiliyor ve validate.py yapısal
# tutarlılığı kontrol ediyor: maç sayısı == takım × (takım − 1).
LEAGUES = {
    "EPL": {
        "name": "Premier Lig",
        "flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
        "understat": "EPL",
        "fotmob": 47,
    },
    "La_Liga": {
        "name": "La Liga",
        "flag": "🇪🇸",
        "understat": "La_liga",
        "fotmob": 87,
    },
    "Serie_A": {
        "name": "Serie A",
        "flag": "🇮🇹",
        "understat": "Serie_A",
        "fotmob": 55,
    },
    "Bundesliga": {
        "name": "Bundesliga",
        "flag": "🇩🇪",
        "understat": "Bundesliga",
        "fotmob": 54,
    },
    "Ligue_1": {
        "name": "Ligue 1",
        "flag": "🇫🇷",
        "understat": "Ligue_1",
        "fotmob": 53,
    },
    "TSL": {
        "name": "Süper Lig",
        "flag": "🇹🇷",
        "fotmob": 71,
        "has_xg": False,  # FotMob lig fikstür ucunda xG yok
    },
}

# Bir ligin takım sayısı bu aralığın dışındaysa veri şüphelidir.
TEAM_COUNT_RANGE = (16, 22)

# Birincil kaynak: Understat varsa o (xG için). FotMob her ligde tanımlı ama
# yalnızca Understat'ın kapsamadığı liglerde birincil kaynak olarak kullanılıyor;
# diğerlerinde logo ve hafta numarası için ikincil kaynak.
UNDERSTAT_LEAGUES = [k for k, v in LEAGUES.items() if v.get("understat")]
FOTMOB_LEAGUES = [k for k, v in LEAGUES.items() if v.get("fotmob")]
FOTMOB_PRIMARY_LEAGUES = [
    k for k, v in LEAGUES.items() if v.get("fotmob") and not v.get("understat")
]

# ─── Sızıntı kara listesi ────────────────────────────────────────────────────
# Understat'ın "forecast" alanı maçın KENDİ xG'sinden hesaplanıyor, yani
# maç oynanmadan bilinemez. Feature olarak kullanılırsa model sahte bir
# doğrulukla parlar. Asla ham veriye bile yazılmıyor.
LEAK_FIELDS = frozenset({"forecast"})

# ─── Zaman ───────────────────────────────────────────────────────────────────
# Understat datetime'ları UTC kabul ediliyor; validate.py bunu doğruluyor.
DISPLAY_TZ = "Europe/Istanbul"

# ─── Canlı golcü proxy'si ────────────────────────────────────────────────────
# FotMob tarayıcıya yalnızca maç listesi ucunda CORS izni veriyor; golcü
# bilgisini taşıyan uç kapalı. worker/ altındaki Cloudflare Worker o çağrıyı
# sunucu tarafında yapıyor. Adres boşken site golcü göstermeye çalışmıyor.
GOAL_PROXY_URL = "https://ballinc-proxy.1903batuhancftc.workers.dev/"

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
