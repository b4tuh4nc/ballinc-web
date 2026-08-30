"""Siteyi besleyen JSON'ları üretir.

Site tamamen statik: sunucu yok, canlı hesap yok. Bu dosyanın çıktısı
`web/data/` altındaki JSON'lar ve sayfa sadece onları okuyor. Scraping veya
model tarafında bir şey bozulursa pipeline `validate` adımında durur ve
site son çalışan JSON'la ayakta kalmaya devam eder.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from pipeline import crosswalk, features, market, predict as predict_mod
from pipeline.config import (
    CURRENT_SEASON,
    GOAL_PROXY_URL,
    LEAGUES,
    DISPLAY_TZ,
    MODELS_DIR,
    TEAM_DISPLAY_NAMES,
    WEB_DATA_DIR,
    season_label,
)
from pipeline.model import GoalModel

_ORIGINAL_NAMES = {v: k for k, v in TEAM_DISPLAY_NAMES.items()}

FORM_LENGTH = 5


def _team_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Oynanmış maçları takım perspektifine açar (puan tablosu için)."""
    home = df.assign(
        team_id=df["home_id"], team=df["home_team"], short=df["home_short"],
        gf=df["home_goals"], ga=df["away_goals"],
        xgf=df["home_xg"], xga=df["away_xg"], venue="H",
    )
    away = df.assign(
        team_id=df["away_id"], team=df["away_team"], short=df["away_short"],
        gf=df["away_goals"], ga=df["home_goals"],
        xgf=df["away_xg"], xga=df["home_xg"], venue="A",
    )
    cols = ["match_id", "datetime", "team_id", "team", "short",
            "gf", "ga", "xgf", "xga", "venue"]
    return pd.concat([home[cols], away[cols]], ignore_index=True)


def _outcome(gf: float, ga: float) -> str:
    return "G" if gf > ga else ("B" if gf == ga else "M")


def build_standings(season_df: pd.DataFrame) -> list[dict]:
    """Puan durumu + son 5 maç formu."""
    played = season_df[season_df["is_result"]]
    if played.empty:
        return []

    rows = _team_rows(played).sort_values("datetime")
    table = []
    for team_id, group in rows.groupby("team_id"):
        outcomes = [_outcome(r.gf, r.ga) for r in group.itertuples()]
        wins = outcomes.count("G")
        draws = outcomes.count("B")
        losses = outcomes.count("M")
        table.append({
            "team_id": team_id,
            "team": group["team"].iat[-1],
            "short": group["short"].iat[-1],
            "played": len(group),
            "w": wins, "d": draws, "l": losses,
            "gf": int(group["gf"].sum()),
            "ga": int(group["ga"].sum()),
            "gd": int(group["gf"].sum() - group["ga"].sum()),
            "points": wins * 3 + draws,
            "xgf": round(float(group["xgf"].mean()), 2) if group["xgf"].notna().any() else None,
            "xga": round(float(group["xga"].mean()), 2) if group["xga"].notna().any() else None,
            "form": outcomes[-FORM_LENGTH:],
        })

    table.sort(key=lambda r: (-r["points"], -r["gd"], -r["gf"]))
    for rank, row in enumerate(table, start=1):
        row["rank"] = rank
    return table


def _past_predictions(season_df: pd.DataFrame, model: GoalModel) -> dict[str, dict]:
    """Oynanmış maçlar için modelin maç ÖNCESİ ne diyeceğini hesaplar.

    Bu geriye dönük bir yeniden hesaplama, canlı kaydedilmiş tahmin değil —
    ve sitede öyle etiketleniyor. Dürüst olmasının sebebi feature katmanının
    her maçın girdilerini yalnızca o maç başlamadan önce biten maçlardan
    üretmesi; bu `tests/test_features.py` ile zorunlu kılınıyor.

    Yayında kaydedilmiş gerçek tahmin geçmişi ayrı tutuluyor
    (data/predictions.sqlite, "Yayındaki isabet" tablosu).
    """
    played = season_df[season_df["result"].notna()]
    if played.empty:
        return {}

    missing = [c for c in model.features if c not in played.columns]
    if missing:
        return {}

    probs, _ = model.predict_markets(played[model.features])
    out = {}
    for pos, row in enumerate(played.itertuples(index=False)):
        result = probs["result"][pos]
        pick = int(result.argmax())
        out[row.match_id] = {
            "probs": [round(float(v), 4) for v in result],
            "pick": pick,
            "hit": bool(pick == int(row.result)),
        }
    return out


def build_results(season_df: pd.DataFrame, predictions: dict | None = None) -> list[dict]:
    """Sezonun oynanmış BÜTÜN maçları, hafta numarasıyla.

    Eskiden yalnızca son 20 maç veriliyordu; sezonun ilk haftaları siteden
    görünmüyordu. Tam sezon 380 maçta ~80 KB tutuyor, bu boyut için sayfalama
    yapmaya değmez.
    """
    played = season_df[season_df["is_result"]].sort_values("datetime", ascending=False)
    out = []
    for row in played.itertuples():
        round_no = getattr(row, "round", None)
        forecast = (predictions or {}).get(row.match_id)
        out.append({
            "forecast": forecast,
            "id": row.match_id,
            "kickoff": row.datetime.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "round": int(round_no) if pd.notna(round_no) else None,
            "home": {"id": row.home_id, "name": row.home_team, "short": row.home_short},
            "away": {"id": row.away_id, "name": row.away_team, "short": row.away_short},
            "score": [int(row.home_goals), int(row.away_goals)],
            "xg": (
                [round(float(row.home_xg), 2), round(float(row.away_xg), 2)]
                if pd.notna(row.home_xg) else None
            ),
        })
    return out


def attach_fotmob_ids(matches: list[dict]) -> int:
    """Her maça FotMob takım kimliklerini ekler.

    Site, canlı skorları tarayıcıdan doğrudan FotMob'dan çekiyor; gelen olayı
    bizim fikstürümüzle eşleştirmek için ortak bir anahtar gerekiyor. İsimle
    eşleştirmek yerine kimlik kullanılıyor — isim eşleştirmesi bu projede
    zaten bir kez pahalıya patlamıştı.
    """
    entries = crosswalk.load()
    hits = 0
    for match in matches:
        for side in ("home", "away"):
            team_id = match[side]["id"]
            if str(team_id).startswith("fm"):
                match[side]["fm"] = str(team_id).removeprefix("fm")
            elif team_id in entries:
                match[side]["fm"] = entries[team_id]["fotmob_id"]
        if "fm" in match["home"] and "fm" in match["away"]:
            hits += 1
    return hits


# Sonuç günlerinden kaç günü dizine alıyoruz. Sıfır olsaydı bugün maçları
# biten bir lig dizine hiç girmezdi: maçlar tahmin listesinden düşüyor,
# sayfa o ligin dosyasını indirmiyor ve o gün oynanmış maçlar kayboluyordu.
# Süper Lig, Premier Lig ve Eredivisie'de tam olarak bu oldu.
RESULT_DAYS_IN_INDEX = 7


def build_day_index(by_league: dict, results_by_league: dict) -> dict:
    """Gün → o gün maçı olan yarışmalar ve maç sayısı.

    Hem tahminler hem yakın geçmişin sonuçları giriyor. Tarih site ile AYNI
    şekilde hesaplanıyor: Türkiye saatine göre gün. UTC'ye göre
    hesaplansaydı gece yarısını aşan maçlar bir gün kayardı ve sayfa o günün
    dosyasını hiç indirmezdi.
    """
    def day_of(kickoff: str) -> str:
        return (datetime.fromisoformat(kickoff.replace("Z", "+00:00"))
                .astimezone(ZoneInfo(DISPLAY_TZ)).date().isoformat())

    today = datetime.now(ZoneInfo(DISPLAY_TZ)).date()
    earliest = (today - timedelta(days=RESULT_DAYS_IN_INDEX)).isoformat()

    days: dict[str, dict] = {}

    def add(day: str, code: str) -> None:
        slot = days.setdefault(day, {"n": 0, "leagues": []})
        slot["n"] += 1
        if code not in slot["leagues"]:
            slot["leagues"].append(code)

    predictions = 0
    for code, matches in by_league.items():
        for match in matches:
            add(day_of(match["kickoff"]), code)
            predictions += 1

    for code, results in results_by_league.items():
        for result in results:
            day = day_of(result["kickoff"])
            if day >= earliest:
                add(day, code)

    return {
        "days": dict(sorted(days.items())),
        "total": predictions,
    }


def build_teams(df) -> list[dict]:
    """Arama ve favori için bütün takımların dizini.

    Güncel sezonun bütün maçlarından türetiliyor (oynanmış veya değil), yani
    ligden düşmüş takımlar listeye girmiyor. Kimlik kanonik takım kimliği;
    logo dosyaları da aynı adla duruyor.
    """
    season = df[df["season"] == CURRENT_SEASON]
    # FotMob'un yerel yazımı arama takma adı olarak ekleniyor: bizim kanonik
    # adımız Understat'tan geliyor ("Bayern Munich") ama kullanıcı yerel
    # yazımı arayabilir ("Bayern München").
    entries = crosswalk.load()
    aliases = {us_id: e["fotmob_name"] for us_id, e in entries.items()}

    teams: dict[str, dict] = {}
    for row in season.itertuples(index=False):
        for team_id, name, league in (
            (row.home_id, row.home_team, row.league),
            (row.away_id, row.away_team, row.league),
        ):
            if team_id in teams:
                continue
            entry = {"id": team_id, "name": name, "league": league}
            # Arama takma adları: FotMob'un yerel yazımı ve — ad
            # düzeltildiyse — Understat'ın eski adı. Kullanıcı "Cologne"
            # arayınca da Köln'ü bulabilmeli.
            alts = []
            alias = aliases.get(team_id)
            if alias and alias != name:
                alts.append(alias)
            original = _ORIGINAL_NAMES.get(name)
            if original and original != alias:
                alts.append(original)
            if alts:
                entry["alt"] = alts
            # FotMob kimligi: canli veri isimle degil kimlikle geliyor, favori
            # takimin bildirimi de bu esleme uzerinden bulunuyor.
            fm = (str(team_id).removeprefix("fm") if str(team_id).startswith("fm")
                  else (entries.get(team_id) or {}).get("fotmob_id"))
            if fm:
                entry["fm"] = str(fm)
            teams[team_id] = entry
    return sorted(teams.values(), key=lambda t: t["name"])


def build_fixtures(season_df) -> list[dict]:
    """Sezonun oynanmamış BÜTÜN maçları — tahminsiz, sade fikstür.

    Ayrı dosyada tutuluyor: lig JSON'una eklenseydi ana sayfa altı ligin
    tamamını yüklediği için birkaç yüz KB fazladan iniyordu. Bu dosya yalnızca
    takım sayfasında isteniyor.
    """
    # Tarihi geçmiş bir maç, sonucu henüz kaynağa yansımamış olsa bile
    # fikstür değildir; is_result bayrağına tek başına güvenilmiyor.
    now = pd.Timestamp.utcnow().tz_localize(None)
    upcoming = season_df[
        (~season_df["is_result"]) & (season_df["datetime"] > now)
    ].sort_values("datetime")
    out = []
    for row in upcoming.itertuples():
        round_no = getattr(row, "round", None)
        out.append({
            "id": row.match_id,
            "kickoff": row.datetime.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "round": int(round_no) if pd.notna(round_no) else None,
            "home": {"id": row.home_id, "name": row.home_team},
            "away": {"id": row.away_id, "name": row.away_team},
        })
    return out


def _write(path, payload) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def _warn_if_stale(df) -> None:
    """Bu export'un siteden silecegi maclari say ve soyle.

    Export ne bulursa onu yayinliyor. Lokalde eski `data/raw/` ile calistirip
    sonucu commit'lemek, o sirada bitmis maclari siteden TAMAMEN siliyor: mac
    yaklasanlardan dusuyor (kick-off 3.5 saati gecmis) ama sonuclara da
    girmiyor (ham veride skoru yok). Site canli skordan tamamlayamiyor cunku
    mac artik hicbir listede degil.

    Sureye bakmak yetmiyor -- 4.5 saatlik veri bile mac kaybettirebiliyor.
    Dogrudan asil arizaya bakiliyor: baslamis ama sonucu olmayan mac var mi?
    """
    season = df[df["season"] == CURRENT_SEASON]
    cutoff = (pd.Timestamp.utcnow().tz_localize(None)
              - pd.Timedelta(hours=predict_mod.LIVE_WINDOW_HOURS))
    orphan = season[(season["datetime"] < cutoff) & (~season["is_result"].astype(bool))]
    if orphan.empty:
        return
    print(f"\n  ! {len(orphan)} mac baslamis ama sonucu ham veride yok. Bu export"
          f" onlari\n    siteden tamamen siler (ne yaklasanlarda ne sonuclarda"
          f" gorunurler).\n    Commit etmeden once `python -m pipeline.ingest`"
          f" calistir ya da CI'ya birak.")
    for row in orphan.head(5).itertuples(index=False):
        print(f"      {row.datetime:%d.%m %H:%M}  {row.home_team} - {row.away_team}")
    print()


def _rename_teams(df):
    """Görünen adları tek noktada uygula.

    Sütunlar burada değiştiği için matchler, puan durumu, fikstür ve takım
    dizini otomatik olarak düzeltilmiş adı alıyor; her yazım noktasını ayrı
    ayrı yamamak gerekmiyor.
    """
    for side in ("home", "away"):
        df[f"{side}_team"] = df[f"{side}_team"].replace(TEAM_DISPLAY_NAMES)
    return df


def main() -> int:
    df = _rename_teams(predict_mod.load_features())
    _warn_if_stale(df)
    model = GoalModel.load(MODELS_DIR)

    metrics_path = MODELS_DIR / "metrics.json"
    metrics = json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.exists() else {}

    all_upcoming = predict_mod.upcoming(df)
    predictions = predict_mod.predict(all_upcoming, model)
    market.attach(predictions)
    linked = attach_fotmob_ids(predictions)
    by_league: dict[str, list[dict]] = {}
    results_by_league: dict[str, list[dict]] = {}
    for p in predictions:
        by_league.setdefault(p["league"], []).append(p)

    league_metrics = metrics.get("leagues", {})
    league_meta = []
    for code, cfg in LEAGUES.items():
        season_df = df[(df["league"] == code) & (df["season"] == CURRENT_SEASON)]
        matches = by_league.get(code, [])

        # Oynanmış maçlara da FotMob takım kimliği: maç sayfasındaki olay
        # akışı bitmiş maçlarda da gösteriliyor ve proxy maçı tarih + takım
        # kimliğiyle buluyor (FotMob maç kimliği elimizde yok).
        results = build_results(season_df, _past_predictions(season_df, model))
        attach_fotmob_ids(results)      # yerinde ekliyor
        results_by_league[code] = results

        payload = {
            "league": code,
            "name": cfg["name"],
            "flag": cfg["flag"],
            "season": season_label(CURRENT_SEASON),
            "has_xg": cfg.get("has_xg", True),
            # Bu ligde modelin geriye dönük ölçülmüş performansı. Lig
            # kalitesi hakkında varsayım yapmak yerine rakamı gösteriyoruz.
            "metrics": league_metrics.get(code, {}),
            "matches": matches,
            "results": results,
            "standings": build_standings(season_df),
        }
        size = _write(WEB_DATA_DIR / f"{code}.json", payload)
        fixtures = build_fixtures(season_df)
        if fixtures:
            _write(WEB_DATA_DIR / f"{code}-fixtures.json", {"fixtures": fixtures})

        league_meta.append({
            "code": code,
            "name": cfg["name"],
            "flag": cfg["flag"],
            # 0/yok: üst çubukta gösterilen ana ligler. 1: Avrupa kupaları.
            # 2: kupalara takım gönderen ligler. Yirmi yarışmayı üst çubuğa
            # dizmek kullanılamaz olurdu; ikisi de menüden ulaşılabiliyor.
            "tier": cfg.get("tier", 0),
            "has_xg": cfg.get("has_xg", True),
            "upcoming": len(matches),
            "played": int(season_df["is_result"].sum()),
        })
        note = "" if len(season_df) else "  (bu sezon için veri yok)"
        print(f"  {code:12s} {len(matches):3d} tahmin, "
              f"{len(payload['standings']):2d} takım, {size / 1024:6.1f} KB{note}")

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "season": season_label(CURRENT_SEASON),
        "leagues": league_meta,
        "metrics": metrics.get("markets", {}),
        # Modelin kurduğu cümlenin ne kadar tuttuğu: güven dilimi başına
        # ölçülmüş isabet. Site bu rakamı gösteriyor, uydurmuyor.
        "confidence": metrics.get("confidence", []),
        # Modelin nerede kaybettiği: güç farkına göre kırılım.
        "elo_gaps": metrics.get("elo_gaps", []),
        "window_days": predict_mod.PREDICT_WINDOW_DAYS,
        "goal_proxy": GOAL_PROXY_URL,
    }
    # Gün dizini: ana sayfa tek bir günü gösteriyor ama yirmi lig dosyasının
    # tamamını indiriyordu (1 MB). Bu dizin hangi günde hangi yarışmanın maçı
    # olduğunu söylüyor; sayfa yalnızca o günün dosyalarını çekiyor.
    _write(WEB_DATA_DIR / "index.json",
           build_day_index(by_league, results_by_league))

    teams = build_teams(df)
    _write(WEB_DATA_DIR / "teams.json", {"teams": teams})
    print(f"  {'takım dizini':12s} {len(teams):3d} takım")

    _write(WEB_DATA_DIR / "meta.json", meta)
    print(f"\n{len(predictions)} tahmin → {WEB_DATA_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
