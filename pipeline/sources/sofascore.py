"""SofaScore veri kaynağı — Understat kapsamı dışındaki ligler (şu an Süper Lig).

SofaScore'un API'si düz `requests` ile 403 döndürüyor (Cloudflare), bu yüzden
headless Chrome üzerinden okunuyor. Bu kaynak bilerek ikinci sınıf:
  * xG yok — TSL tahminleri yalnızca gol ve form verisine dayanıyor.
  * Selenium kırılgan; bu yüzden yalnızca arka plan işinde çalışıyor,
    sitenin çalışması buna bağlı değil.

Sezon ID'leri her sezon değiştiği için hardcoded tutulmuyor; `/seasons`
ucundan okunup config'deki sezon etiketiyle eşleştiriliyor.
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager

import pandas as pd

from pipeline.config import LEAGUES, season_label
from pipeline.sources.understat import COLUMNS

API = "https://www.sofascore.com/api/v1"
# Bir sezon 18 takımlı ligde 306 maç, sayfa başına ~30 olay geliyor.
# 'last' ve 'next' ayrı ayrı sayfalandığı için limit ikisine de yetmeli.
PAGE_LIMIT = 16
PAGE_PAUSE = 2.0


class SofascoreError(RuntimeError):
    pass


@contextmanager
def browser():
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    options = Options()
    for arg in ("--headless=new", "--disable-gpu", "--no-sandbox",
                "--disable-dev-shm-usage", "--window-size=1200,900"):
        options.add_argument(arg)
    options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
    driver = webdriver.Chrome(options=options)
    try:
        yield driver
    finally:
        driver.quit()


def _get(driver, url: str, retries: int = 3) -> dict:
    """JSON okur. Hata gövdelerini başarı sanmaz.

    Chrome, API'nin döndürdüğü hata JSON'unu da (`{"error": {"code": 403}}`)
    bir <pre> içinde gösteriyor. Bu gövde sorunsuz parse edildiği için
    "boş ama geçerli yanıt" gibi görünüyor ve lig sessizce atlanıyordu.
    Hata anahtarı artık açıkça yakalanıyor.
    """
    last = "bilinmeyen hata"
    for attempt in range(retries):
        driver.get(url)
        time.sleep(PAGE_PAUSE)
        try:
            payload = json.loads(driver.find_element("tag name", "pre").text)
        except Exception as exc:
            last = f"gövde JSON değil ({type(exc).__name__}) — muhtemelen Cloudflare sayfası"
            payload = None

        if isinstance(payload, dict):
            error = payload.get("error")
            if error:
                last = f"API hatası: {error}"
            else:
                return payload

        if attempt < retries - 1:
            time.sleep(PAGE_PAUSE * (attempt + 2))

    raise SofascoreError(f"{url} → {last}")


def season_id(driver, tournament: int, season: str) -> int | None:
    """'2026_2027' → SofaScore sezon id'si. Sezon listede yoksa None.

    Boş sezon listesi meşru bir sonuç değil: her turnuvanın en az bir sezonu
    vardır. Boş dönerse erişim engellenmiş demektir ve bu, "sezon yok" ile
    karıştırılmamalı — biri atlanır, diğeri pipeline'ı durdurur.
    """
    payload = _get(driver, f"{API}/unique-tournament/{tournament}/seasons")
    seasons = payload.get("seasons") or []
    if not seasons:
        raise SofascoreError(
            f"turnuva {tournament} için sezon listesi boş döndü — erişim engellenmiş olabilir"
        )
    wanted = season_label(season)
    for entry in seasons:
        if entry.get("year") == wanted:
            return int(entry["id"])
    return None


def _events(driver, tournament: int, sid: int, period: str) -> list[dict]:
    collected = []
    for page in range(PAGE_LIMIT):
        url = f"{API}/unique-tournament/{tournament}/season/{sid}/events/{period}/{page}"
        try:
            payload = _get(driver, url)
        except SofascoreError:
            break
        events = payload.get("events", [])
        if not events:
            break
        collected.extend(events)
        if not payload.get("hasNextPage", True):
            break
    return collected


def _score(value) -> float | None:
    if not isinstance(value, dict):
        return None
    for key in ("current", "display"):
        raw = value.get(key)
        if raw is not None and str(raw).isdigit():
            return float(raw)
    return None


def _row(event: dict, league: str, season: str) -> dict:
    home, away = event["homeTeam"], event["awayTeam"]
    finished = (event.get("status") or {}).get("type") == "finished"
    home_goals = _score(event.get("homeScore"))
    away_goals = _score(event.get("awayScore"))
    return {
        "match_id": f"ss{event['id']}",
        "datetime": pd.to_datetime(event["startTimestamp"], unit="s"),
        "league": league,
        "season": season,
        "home_id": f"ss{home['id']}",
        "away_id": f"ss{away['id']}",
        "home_team": home["name"],
        "away_team": away["name"],
        "home_short": home.get("nameCode"),
        "away_short": away.get("nameCode"),
        "home_goals": home_goals if finished else None,
        "away_goals": away_goals if finished else None,
        "home_xg": None,   # SofaScore event listesinde xG yok
        "away_xg": None,
        "is_result": bool(finished and home_goals is not None),
    }


def _drop_non_league(df: pd.DataFrame, expected_teams: int) -> pd.DataFrame:
    """Kupa ve hazırlık maçlarını ayıklar.

    Sezonun gerçek kadrosu, en çok maç oynayan `expected_teams` takımdır;
    bir maç ancak iki takımı da bu kadroda ise ligdendir. Eski sistem
    "takımlardan biri tanıdıksa al" diyordu ve EPL dosyasına 37 fazladan
    maç sızmıştı.
    """
    counts = pd.concat([df["home_id"], df["away_id"]]).value_counts()
    roster = set(counts.head(expected_teams).index)
    return df[df["home_id"].isin(roster) & df["away_id"].isin(roster)]


def fetch_league_season(league: str, season: str, driver=None) -> pd.DataFrame:
    """Bir lig-sezonu Understat ile aynı şemada döndürür."""
    cfg = LEAGUES[league]
    tournament = cfg.get("sofascore")
    if not tournament:
        raise ValueError(f"{league} SofaScore kapsamında değil")

    def work(drv):
        sid = season_id(drv, tournament, season)
        if sid is None:
            return pd.DataFrame(columns=COLUMNS)

        events = _events(drv, tournament, sid, "last") + _events(drv, tournament, sid, "next")
        if not events:
            return pd.DataFrame(columns=COLUMNS)

        df = pd.DataFrame([_row(e, league, season) for e in events], columns=COLUMNS)
        df = df.drop_duplicates(subset=["match_id"])
        df = _drop_non_league(df, cfg["teams"])
        df = df.drop_duplicates(subset=["home_id", "away_id"], keep="first")

        # xG sütunları tamamen boş; dtype'ı açıkça float yapmazsak object
        # kalıp Understat çerçeveleriyle birleşirken tip çakışması yaratıyor.
        for col in ("home_goals", "away_goals", "home_xg", "away_xg"):
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("float64")
        df["is_result"] = df["is_result"].astype(bool)
        df["has_xg"] = False
        return df.sort_values("datetime").reset_index(drop=True)

    if driver is not None:
        return work(driver)
    with browser() as drv:
        return work(drv)
