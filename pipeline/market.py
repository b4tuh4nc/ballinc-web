"""Bahis oranlarını çeker ve data/market_odds.json'a yazar.

Ağ erişimi burada izole: `export` ve `track` yalnızca bu dosyanın çıktısını
okur. Oran servisi çökerse ya da kota biterse site son bilinen oranlarla
çalışmaya devam eder, hiçbir tahmin kaybolmaz.

Kota, bu dosyadaki her kararın sebebi. Ücretsiz plan ayda 500 istek veriyor
ve her yarışma bir istek. 17 yarışmayı her çalıştırmada çekmek ayda ~1200
istek eder, yani kota ayın üçte birinde biter. Onun yerine iki kademe var:

  1. Yalnızca ufuktaki (ODDS_HORIZON_DAYS) maçı olan yarışmalar aday.
     Bahisçiler bir haftadan uzak maçlara zaten fiyat vermiyor, o istekler
     boşa giderdi.
  2. Adaylar maç saatine yakınlığa göre sıralanıyor ve ayın kalan gününe
     bölünmüş bir bütçe kadarı çekiliyor. Bütçe API'nin bildirdiği kalan
     kotadan hesaplandığı için kendi kendini düzeltir: kota azaldıkça
     çalıştırma başına daha az yarışma çekilir, ay ortasında bitmez.

Zamanlama da artık burada. Eskiden saat kontrolü iş akışının YAML'ındaydı ve
"saat 10 veya 16 ise çek" diyordu; cron ise üç saatte bir tetikliyor, yani 10
ve 16 hiç gelmiyordu. Oran çekimi ancak GitHub'ın zamanlama gecikmesi
tesadüfen o saate denk düşerse çalışıyordu. Şimdi iş akışı bu dosyayı her
çalıştırmada çağırıyor, gerekmiyorsa kendisi çıkıyor.
"""

from __future__ import annotations

import calendar
import json
import sys
from datetime import datetime, timedelta, timezone

import pandas as pd

from pipeline.config import CURRENT_SEASON, DATA_DIR, LEAGUES, raw_path
from pipeline.sources import odds

MARKET_PATH = DATA_DIR / "market_odds.json"

# Bahisçilerin fiyat verdiği ufuk. Bundan uzağı istemek kota harcayıp boş
# yanıt almak demek.
ODDS_HORIZON_DAYS = 7

# Ay sonuna saklanan pay. Bütçe hesabı bunu hiç harcamıyor ki ayın son
# günlerinde de oran gelebilsin.
QUOTA_RESERVE = 40

# Bütçeyi bölerken varsaydığımız günlük çalıştırma sayısı. Cron üç saatte bir
# tetikliyor ama MIN_HOURS_BETWEEN_RUNS ile pratikte bu kadarı çalışıyor.
RUNS_PER_DAY = 4
MIN_HOURS_BETWEEN_RUNS = 5

# Kota bilgisi hiç yoksa (ilk çalıştırma) varsayılan aylık hak.
DEFAULT_QUOTA = 500


def league_teams(league: str) -> dict[str, str]:
    """Güncel sezondaki takımlar: kanonik kimlik → görünen ad."""
    path = raw_path(league, CURRENT_SEASON)
    if not path.exists():
        return {}
    df = pd.read_parquet(path)
    teams: dict[str, str] = {}
    for row in df.itertuples(index=False):
        teams[row.home_id] = row.home_team
        teams[row.away_id] = row.away_team
    return teams


def league_fixtures(league: str) -> dict[tuple[str, str], datetime]:
    """Oynanmamış maçlar: (ev, deplasman) → başlama saati (UTC)."""
    path = raw_path(league, CURRENT_SEASON)
    if not path.exists():
        return {}
    df = pd.read_parquet(path)
    if "is_result" in df.columns:
        df = df[~df["is_result"].fillna(False).astype(bool)]
    out: dict[tuple[str, str], datetime] = {}
    for row in df.itertuples(index=False):
        stamp = pd.Timestamp(row.datetime)
        if pd.isna(stamp):
            continue
        out[(row.home_id, row.away_id)] = (
            stamp.to_pydatetime().replace(tzinfo=timezone.utc)
        )
    return out


def _refresh_hours(hours_to_kickoff: float) -> float:
    """Maça ne kadar kaldıysa o kadar sık tazele.

    Oranlar kick-off'a yakın oynuyor; bir hafta öncesinden alınan fiyat maç
    günü zaten geçersiz. Uzaktaki maça sık istek atmak da kotayı boşa yakar.
    """
    if hours_to_kickoff <= 24:
        return 12
    if hours_to_kickoff <= 72:
        return 30
    return 84


def _budget(remaining: int, now: datetime) -> int:
    """Bu çalıştırmada kaç yarışma çekilebilir."""
    days_left = calendar.monthrange(now.year, now.month)[1] - now.day + 1
    usable = max(0, remaining - QUOTA_RESERVE)
    return max(1, usable // max(days_left, 1) // RUNS_PER_DAY)


def _parse(stamp: str | None) -> datetime | None:
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(stamp)
    except ValueError:
        return None


def attach(predictions: list[dict]) -> int:
    """Her maça piyasa olasılığını ve beklenen değeri ekler.

    EV pozitifse model o sonuca piyasanın fiyatladığından daha yüksek ihtimal
    veriyor demektir. Bu bir kâr vaadi DEĞİL: modelin piyasayı gerçekten
    geçtiği, tahminler sonuçlandıkça `track.py` içinde ölçülüyor ve sitede
    ayrıca yayınlanıyor.
    """
    entries = load().get("odds", {})
    if not entries:
        return 0

    hits = 0
    for match in predictions:
        key = f"{match['league']}|{match['home']['id']}|{match['away']['id']}"
        found = entries.get(key)
        if not found:
            continue
        model_probs = match["markets"]["result"]
        match["market"] = {
            "probs": found["market"],
            "best_odds": found["best_odds"],
            "bookmakers": found["bookmakers"],
            "margin": found["margin"],
            "ev": odds.expected_value(model_probs, found["best_odds"]),
        }
        hits += 1
    return hits


def load() -> dict:
    if not MARKET_PATH.exists():
        return {}
    return json.loads(MARKET_PATH.read_text(encoding="utf-8"))


def _prune(entries: dict, fixtures: dict[str, set]) -> int:
    """Oynanmış maçların oranlarını atar.

    Anahtar (lig, ev, deplasman) olduğu için temizlenmezse geçen sezonun aynı
    eşleşmesi bu sezonun maçına yapışırdı. Ligin fikstürü hiç okunamadıysa o
    ligin kayıtlarına dokunulmuyor: veri çekimi o turda başarısız olduysa
    elimizdeki oranları silmek yanlış olur.
    """
    dropped = 0
    for key in list(entries):
        league = key.split("|")[0]
        known = fixtures.get(league)
        if not known:
            continue
        if key not in known:
            del entries[key]
            dropped += 1
    return dropped


def main() -> int:
    key = odds.api_key()
    if not key:
        print("ODDS_API_KEY tanımlı değil, oran adımı atlandı.")
        return 0

    now = datetime.now(timezone.utc)
    previous = load()
    entries: dict[str, dict] = dict(previous.get("odds", {}))
    per_league: dict[str, str] = dict(previous.get("leagues", {}))

    last_run = _parse(previous.get("fetched_at"))
    if last_run and (now - last_run) < timedelta(hours=MIN_HOURS_BETWEEN_RUNS):
        since = (now - last_run).total_seconds() / 3600
        print(f"Son çekimin üzerinden {since:.1f} saat geçmiş "
              f"({MIN_HOURS_BETWEEN_RUNS} saat bekleniyor); atlandı.")
        return 0

    # Aday yarışmalar: ufukta maçı olan ve tazelenme vakti gelmiş olanlar.
    fixture_keys: dict[str, set] = {}
    candidates: list[tuple[datetime, str]] = []
    horizon = now + timedelta(days=ODDS_HORIZON_DAYS)

    for league in LEAGUES:
        if league not in odds.SPORT_KEYS:
            continue
        fixtures = league_fixtures(league)
        if not fixtures:
            continue
        fixture_keys[league] = {
            f"{league}|{home}|{away}" for home, away in fixtures
        }
        upcoming = [when for when in fixtures.values() if when > now]
        if not upcoming:
            continue
        soonest = min(upcoming)
        if soonest > horizon:
            continue
        hours = (soonest - now).total_seconds() / 3600
        last = _parse(per_league.get(league))
        if last and (now - last).total_seconds() / 3600 < _refresh_hours(hours):
            continue
        candidates.append((soonest, league))

    dropped = _prune(entries, fixture_keys)

    remaining = int(previous.get("quota_remaining") or DEFAULT_QUOTA)
    budget = _budget(remaining, now)
    candidates.sort()
    chosen = [league for _, league in candidates[:budget]]

    print(f"Kalan kota {remaining}, bu turda bütçe {budget} yarışma; "
          f"{len(candidates)} aday, {len(chosen)} çekiliyor.")
    if dropped:
        print(f"{dropped} oynanmış maçın oranı temizlendi.")

    quota = None
    failed = []
    fetched_any = False

    for league in chosen:
        teams = league_teams(league)
        if not teams:
            continue
        try:
            fetched, quota = odds.fetch_league(league, teams, key)
        except Exception as exc:
            # Bir ligin oranı gelmezse eskisi korunuyor; akış durmuyor.
            print(f"  ! {league:12s} alınamadı ({type(exc).__name__}: {exc})")
            failed.append(league)
            continue

        for (home_id, away_id), value in fetched.items():
            entries[f"{league}|{home_id}|{away_id}"] = value
        per_league[league] = now.isoformat(timespec="seconds")
        fetched_any = True
        print(f"  ✓ {league:12s} {len(fetched):2d} maç")

    if not (fetched_any or dropped):
        print("Ufukta tazelenmesi gereken yarışma yok; dosya değişmedi.")
        return 0

    payload = {
        # Yalnızca gerçekten istek atılan tur damgalanıyor: boş geçen tur
        # damgalasaydı bir sonraki tur gereksiz yere beklerdi.
        "fetched_at": (now.isoformat(timespec="seconds") if fetched_any
                       else previous.get("fetched_at")),
        "quota_remaining": (quota or {}).get("remaining") or remaining,
        "leagues": per_league,
        "odds": entries,
    }
    MARKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    MARKET_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"\n{len(entries)} maçlık oran → {MARKET_PATH}")
    print(f"Kalan aylık kota: {payload['quota_remaining']}")
    if failed:
        print(f"{len(failed)} lig alınamadı, eski oranları korundu: {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
