"""Siteyi besleyen JSON'ları üretir.

Site tamamen statik: sunucu yok, canlı hesap yok. Bu dosyanın çıktısı
`web/data/` altındaki JSON'lar ve sayfa sadece onları okuyor. Scraping veya
model tarafında bir şey bozulursa pipeline `validate` adımında durur ve
site son çalışan JSON'la ayakta kalmaya devam eder.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from pipeline import features, predict as predict_mod
from pipeline.config import (
    CURRENT_SEASON,
    LEAGUES,
    MODELS_DIR,
    WEB_DATA_DIR,
    season_label,
)
from pipeline.model import GoalModel

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


def build_results(season_df: pd.DataFrame) -> list[dict]:
    """Sezonun oynanmış BÜTÜN maçları, hafta numarasıyla.

    Eskiden yalnızca son 20 maç veriliyordu; sezonun ilk haftaları siteden
    görünmüyordu. Tam sezon 380 maçta ~80 KB tutuyor, bu boyut için sayfalama
    yapmaya değmez.
    """
    played = season_df[season_df["is_result"]].sort_values("datetime", ascending=False)
    out = []
    for row in played.itertuples():
        round_no = getattr(row, "round", None)
        out.append({
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


def _write(path, payload) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def main() -> int:
    df = predict_mod.load_features()
    model = GoalModel.load(MODELS_DIR)

    metrics_path = MODELS_DIR / "metrics.json"
    metrics = json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.exists() else {}

    all_upcoming = predict_mod.upcoming(df)
    predictions = predict_mod.predict(all_upcoming, model)
    by_league: dict[str, list[dict]] = {}
    for p in predictions:
        by_league.setdefault(p["league"], []).append(p)

    league_metrics = metrics.get("leagues", {})
    league_meta = []
    for code, cfg in LEAGUES.items():
        season_df = df[(df["league"] == code) & (df["season"] == CURRENT_SEASON)]
        matches = by_league.get(code, [])

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
            "results": build_results(season_df),
            "standings": build_standings(season_df),
        }
        size = _write(WEB_DATA_DIR / f"{code}.json", payload)

        league_meta.append({
            "code": code,
            "name": cfg["name"],
            "flag": cfg["flag"],
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
        "window_days": predict_mod.PREDICT_WINDOW_DAYS,
    }
    _write(WEB_DATA_DIR / "meta.json", meta)
    print(f"\n{len(predictions)} tahmin → {WEB_DATA_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
