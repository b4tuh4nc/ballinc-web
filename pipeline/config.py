"""Tek doğruluk kaynağı: sezonlar, ligler, yollar.

Yeni sezona geçmek için sadece CURRENT_SEASON ve SEASONS güncellenir.
Eski projede sezon bilgisi 8 ayrı dosyada hardcoded'dı; buradaki tek amaç
bunun bir daha olmaması.
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
# Biten sezonlar bir daha değişmiyor: repoda tutuluyor ve yeniden çekilmiyor.
# Aksi halde her koşuda 60 sezonluk veri indirilirdi — hem yavaş hem kaynağa
# saygısız.
ARCHIVE_DIR = DATA_DIR / "archive"
PROCESSED_DIR = DATA_DIR / "processed"
MODELS_DIR = BASE_DIR / "models"
WEB_DIR = BASE_DIR / "web"
WEB_DATA_DIR = WEB_DIR / "data"
PREDICTIONS_DB = DATA_DIR / "predictions.sqlite"

# ─── Sezonlar ────────────────────────────────────────────────────────────────
CURRENT_SEASON = "2026_2027"

# Model ne kadar çok maç görürse o kadar iyi tahmin ediyor: 3 sezondan 12
# sezona çıkmak walk-forward ölçümde kazancı %7.2'den %8.1'e taşıdı.
# Understat 2014/15'e kadar veri veriyor.
ARCHIVE_SEASONS = [f"{y}_{y + 1}" for y in range(2014, 2025)]
LIVE_SEASONS = ["2025_2026", "2026_2027"]
SEASONS = ARCHIVE_SEASONS + LIVE_SEASONS

# Avrupa kupaları ve besleyici ligler FotMob'da 2021/22'ye kadar var; daha
# eskisini istemek boş dönüyor ve her koşuda gereksiz istek demek.
EUROPE_FIRST_SEASON = "2021_2022"

# Milli takım turnuvaları yıl bazlı sezonlarla çalışır (örn. "2024", "2026").
# Her yarışma için hangi turnuva yıllarının çekileceği burada tanımlanır.
# Daha eski veri modele sinyal katıyor — ancak milli takım Elo'su çok
# eski veriyi gereksiz kılıyor; 2016'dan itibaren yeterli.
INTERNATIONAL_SEASONS: dict[str, list[str]] = {
    "EURO":     ["2020", "2024", "2028"],      # 2020 COVID ertelemeli, gerçekte 2021
    "WC":       ["2022", "2026"],
    "COPA":     ["2021", "2024"],
    "AFCON":    ["2021", "2023", "2025"],       # 2021 = Ocak 2022'de oynandı
    "ASIANCUP": ["2023", "2027"],               # 2023 = Ocak 2024'te oynandı
    "GOLDCUP":  ["2021", "2023", "2025"],
    "UNL_A":    ["2022_2023", "2024_2025", "2026_2027"],
    "UNL_B":    ["2022_2023", "2024_2025", "2026_2027"],
    "UNL_C":    ["2022_2023", "2024_2025", "2026_2027"],
    "UNL_D":    ["2022_2023", "2024_2025", "2026_2027"],
    "WCQ_UEFA": ["2016_2017", "2021_2022", "2025_2026"],
}


def seasons_for(league: str) -> list[str]:
    if LEAGUES[league].get("is_national"):
        # Milli takım turnuvaları yıl bazlı sezonlar kullanır.
        return INTERNATIONAL_SEASONS.get(league, [])
    if not LEAGUES[league].get("tier"):
        return SEASONS
    return [s for s in SEASONS if s >= EUROPE_FIRST_SEASON]


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

    # ─── Avrupa kupalarına takım gönderen ligler ─────────────────────────
    # 2026/27 Avrupa kupalarındaki 108 takımın 42'si yukarıdaki altı ligden,
    # 32'si aşağıdakilerden geliyor. Eklenmeleri kupa maçlarındaki tahmin
    # kazancını +%5.2'den +%6.0'a çıkardı ve altı ligimizin tahminlerine
    # dokunmadı (+%0.04). Ölçüm README'de.
    #
    # Hiçbirinde xG yok: FotMob lig fikstür ucu vermiyor.
    "NED": {"name": "Eredivisie", "flag": "🇳🇱", "fotmob": 57,
            "has_xg": False, "format": "split", "tier": 2},
    "POR": {"name": "Portekiz Ligi", "flag": "🇵🇹", "fotmob": 61,
            "has_xg": False, "tier": 2},
    "BEL": {"name": "Belçika Pro Lig", "flag": "🇧🇪", "fotmob": 40,
            "has_xg": False, "format": "split", "tier": 2},
    "SCO": {"name": "İskoçya Premiership", "flag": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "fotmob": 64,
            "has_xg": False, "format": "split", "tier": 2},
    "GRE": {"name": "Yunanistan Süper Lig", "flag": "🇬🇷", "fotmob": 135,
            "has_xg": False, "format": "split", "tier": 2},
    "CZE": {"name": "Çekya 1. Lig", "flag": "🇨🇿", "fotmob": 122,
            "has_xg": False, "format": "split", "tier": 2},
    "DEN": {"name": "Danimarka Süper Lig", "flag": "🇩🇰", "fotmob": 46,
            "has_xg": False, "format": "split", "tier": 2},
    "AUT": {"name": "Avusturya Bundesliga", "flag": "🇦🇹", "fotmob": 38,
            "has_xg": False, "format": "split", "tier": 2},
    "SUI": {"name": "İsviçre Süper Lig", "flag": "🇨🇭", "fotmob": 69,
            "has_xg": False, "format": "split", "tier": 2},
    "POL": {"name": "Polonya Ekstraklasa", "flag": "🇵🇱", "fotmob": 196,
            "has_xg": False, "tier": 2},
    "CRO": {"name": "Hırvatistan HNL", "flag": "🇭🇷", "fotmob": 252,
            "has_xg": False, "format": "split", "tier": 2},

    # ─── Avrupa kupaları ─────────────────────────────────────────────────
    "UCL": {"name": "Şampiyonlar Ligi", "flag": "🏆", "fotmob": 42,
            "has_xg": False, "format": "cup", "tier": 1},
    "UEL": {"name": "Avrupa Ligi", "flag": "🥈", "fotmob": 73,
            "has_xg": False, "format": "cup", "tier": 1},
    "UECL": {"name": "Konferans Ligi", "flag": "🥉", "fotmob": 10216,
             "has_xg": False, "format": "cup", "tier": 1},

    # ─── Milli takım yarışmaları ─────────────────────────────────────────
    # format="international": yıl bazlı sezon, tarafsız saha ağırlıklı.
    # tier=3: üst çubukta değil, menüden ulaşılabiliyor.
    # FotMob'dan çekiliyor; xG verisi yok.
    #
    # Sezon parametresi yıl bazlı (örn. "2024"), lig/sınıf bazlı değil.
    # Tüm gruplar/eleme turları tek bir sezon altında toplandığı için
    # validate.py çift devreli lig kontrollerini uygulamıyor.
    "EURO": {
        "name": "EURO", "flag": "🇪🇺", "fotmob": 50,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "WC": {
        "name": "Dünya Kupası", "flag": "🌍", "fotmob": 77,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "COPA": {
        "name": "Copa America", "flag": "🌎", "fotmob": 44,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "AFCON": {
        "name": "Afrika Uluslar Kupası", "flag": "🌍", "fotmob": 289,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "ASIANCUP": {
        "name": "Asya Kupası", "flag": "🌏", "fotmob": 290,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "GOLDCUP": {
        "name": "CONCACAF Gold Cup", "flag": "🌎", "fotmob": 298,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "UNL_A": {
        "name": "Uluslar Ligi A", "flag": "🇪🇺", "fotmob": 9806,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "UNL_B": {
        "name": "Uluslar Ligi B", "flag": "🇪🇺", "fotmob": 9807,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "UNL_C": {
        "name": "Uluslar Ligi C", "flag": "🇪🇺", "fotmob": 9808,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "UNL_D": {
        "name": "Uluslar Ligi D", "flag": "🇪🇺", "fotmob": 9809,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
    "WCQ_UEFA": {
        "name": "WC Elemeleri Avrupa", "flag": "🇪🇺", "fotmob": 10195,
        "has_xg": False, "format": "international", "tier": 3,
        "is_national": True,
    },
}


def league_format(league: str) -> str:
    return LEAGUES[league].get("format", DEFAULT_FORMAT)


# Sitede üst çubukta gösterilenler. Yirmi yarışmayı üst çubuğa dizmek
# kullanılamaz hale getirirdi; geri kalanı menüden ve lig filtresinden
# ulaşılabiliyor.
PRIMARY_LEAGUES = [k for k, v in LEAGUES.items() if not v.get("tier")]

# ─── Görünen takım adları ────────────────────────────────────────────────────
# Kanonik ad Understat'tan geliyor ve bazı takımları İngilizceleştiriyor
# ("FC Cologne"), bazılarının resmî uzun adını kullanıyor ("Parma Calcio
# 1913"), bazılarında da aksan düşüyor ("Malaga").
#
# Burası YALNIZCA gösterim. Takım kimlikleri, crosswalk eşlemesi ve maç
# kimlikleri kanonik adla çalışmaya devam ediyor — isim değişikliği bir
# takımın geçmişini koparmıyor. Eski ad arama takma adı olarak korunuyor.
TEAM_DISPLAY_NAMES = {
    "FC Cologne": "Köln",
    "Bayern Munich": "Bayern Münih",
    "Borussia M.Gladbach": "Mönchengladbach",
    "RasenBallsport Leipzig": "RB Leipzig",
    "Athletic Club": "Athletic Bilbao",
    "Atletico Madrid": "Atlético Madrid",
    "Alaves": "Alavés",
    "Malaga": "Málaga",
    "Deportivo La Coruna": "Deportivo La Coruña",
    "AC Milan": "Milan",
    "Parma Calcio 1913": "Parma",
    "Paris Saint Germain": "Paris Saint-Germain",
    
    # --- Milli Takımlar (Türkçe) ---
    "Albania": "Arnavutluk", "Armenia": "Ermenistan", "Austria": "Avusturya", 
    "Azerbaijan": "Azerbaycan", "Belarus": "Belarus", "Belgium": "Belçika", 
    "Bosnia and Herzegovina": "Bosna-Hersek", "Bulgaria": "Bulgaristan", 
    "Croatia": "Hırvatistan", "Cyprus": "Kıbrıs", "Czechia": "Çekya", 
    "Denmark": "Danimarka", "England": "İngiltere", "Estonia": "Estonya", 
    "Faroe Islands": "Faroe Adaları", "Finland": "Finlandiya", "France": "Fransa", 
    "Georgia": "Gürcistan", "Germany": "Almanya", "Gibraltar": "Cebelitarık", 
    "Greece": "Yunanistan", "Hungary": "Macaristan", "Iceland": "İzlanda", 
    "Ireland": "İrlanda", "Israel": "İsrail", "Italy": "İtalya", 
    "Kazakhstan": "Kazakistan", "Kosovo": "Kosova", "Latvia": "Letonya", 
    "Liechtenstein": "Lihtenştayn", "Lithuania": "Litvanya", "Luxembourg": "Lüksemburg", 
    "Montenegro": "Karadağ", "Netherlands": "Hollanda", "North Macedonia": "Kuzey Makedonya", 
    "Northern Ireland": "Kuzey İrlanda", "Norway": "Norveç", "Poland": "Polonya", 
    "Portugal": "Portekiz", "Romania": "Romanya", "Scotland": "İskoçya", 
    "Serbia": "Sırbistan", "Slovakia": "Slovakya", "Slovenia": "Slovenya", 
    "Spain": "İspanya", "Sweden": "İsveç", "Switzerland": "İsviçre", 
    "Turkiye": "Türkiye", "Ukraine": "Ukrayna", "Wales": "Galler",
    "Brazil": "Brezilya", "Argentina": "Arjantin", "Colombia": "Kolombiya", 
    "Chile": "Şili", "Mexico": "Meksika", "USA": "ABD", "Canada": "Kanada", 
    "Japan": "Japonya", "South Korea": "Güney Kore", "Australia": "Avustralya", 
    "Morocco": "Fas", "Egypt": "Mısır", "Nigeria": "Nijerya", "Cameroon": "Kamerun", 
    "Ivory Coast": "Fildişi Sahili", "Algeria": "Cezayir", "Saudi Arabia": "Suudi Arabistan", 
    "Iran": "İran",
}


# Bir ligin takım sayısı bu aralığın dışındaysa veri şüphelidir. Lig başına
# `teams` ile daraltılabilir; Avrupa'nın küçük ligleri 10 takımla oynuyor.
TEAM_COUNT_RANGE = (8, 40)

# Lig formatı — doğrulamanın hangi kuralları uygulayacağını belirler.
#   "double" : çift devreli tam lig. Maç sayısı takım sayısından türetilebilir
#              (T×(T−1)), her takım eşit sayıda ev maçı oynar, bir eşleşme
#              sahada bir kez tekrarlanır.
#   "split"  : lig sonrası şampiyonluk/küme grubu (Hollanda, İskoçya, Belçika,
#              Avusturya, Danimarka, Yunanistan, Çekya, Hırvatistan, İsviçre).
#              Maç sayısı formülle bulunamaz, takımlar farklı sayıda ev maçı
#              oynar ve AYNI eşleşme aynı sahada birden çok kez tekrarlanır.
#   "cup"    : lig aşaması + eleme (Avrupa kupaları). Takımlar eşit sayıda
#              maç bile oynamıyor.
DEFAULT_FORMAT = "double"

# Birincil kaynak: Understat varsa o (xG için). FotMob her ligde tanımlı ama
# yalnızca Understat'ın kapsamadığı liglerde birincil kaynak olarak kullanılıyor;
# diğerlerinde logo ve hafta numarası için ikincil kaynak.
UNDERSTAT_LEAGUES = [k for k, v in LEAGUES.items() if v.get("understat")]
FOTMOB_LEAGUES = [k for k, v in LEAGUES.items() if v.get("fotmob")]
FOTMOB_PRIMARY_LEAGUES = [
    k for k, v in LEAGUES.items()
    if v.get("fotmob") and not v.get("understat") and not v.get("is_national")
]
# Milli takım yarışmaları ayrı bir liste: sezon formatı farklı (yıl bazlı).
NATIONAL_LEAGUES = [k for k, v in LEAGUES.items() if v.get("is_national")]


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
PREDICT_WINDOW_DAYS = 60

# Poisson skor matrisi kenar uzunluğu (0..10 gol)
MAX_GOALS = 11


def understat_year(season: str) -> str:
    """'2026_2027' -> '2026' (Understat sezonu başlangıç yılıyla adlandırır)."""
    return season.split("_")[0]


def season_label(season: str) -> str:
    """'2026_2027' -> '26/27'  |  '2026' -> '2026' (uluslararası turnuvalar)."""
    if "_" not in season:
        # Uluslararası yarışma: "2024", "2026" gibi tek yıl
        return season
    start, end = season.split("_")
    return f"{start[2:]}/{end[2:]}"


def raw_path(league: str, season: str) -> Path:
    """Arşiv sezonları repoda, güncel sezonlar her koşuda tazelenen dizinde."""
    folder = ARCHIVE_DIR if season in ARCHIVE_SEASONS else RAW_DIR
    return folder / f"{league}_{season}.parquet"
