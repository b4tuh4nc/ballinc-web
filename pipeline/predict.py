"""Yaklaşan maçlar için tahmin üretir.

Feature'lar `pipeline.features.build()` içinden geliyor — eğitimle birebir
aynı kod. Ayrı bir "tahmin zamanı form hesabı" yok; eski sistemdeki
eğitim/servis uyumsuzluğunun kaynağı buydu.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from pipeline import features
from pipeline.config import MODELS_DIR, PREDICT_WINDOW_DAYS, PROCESSED_DIR
from pipeline.model import GoalModel, top_scores

# Bu kadar ileri tarihli maçlarda başlama saati genelde henüz kesin değil.
TIME_CONFIRMED_DAYS = 7


def load_features() -> pd.DataFrame:
    path = PROCESSED_DIR / "features.parquet"
    return pd.read_parquet(path) if path.exists() else features.build()


def upcoming(df: pd.DataFrame, now: pd.Timestamp | None = None,
             window_days: int = PREDICT_WINDOW_DAYS) -> pd.DataFrame:
    """Tahmin penceresindeki oynanmamış maçlar."""
    now = now or pd.Timestamp.utcnow().tz_localize(None)
    horizon = now + pd.Timedelta(days=window_days)
    mask = (~df["is_result"]) & (df["datetime"] >= now) & (df["datetime"] <= horizon)
    return df[mask].sort_values("datetime")


def predict(df: pd.DataFrame, model: GoalModel | None = None) -> list[dict]:
    """Verilen maçlar için market olasılıkları ve skor dağılımı."""
    if df.empty:
        return []
    model = model or GoalModel.load(MODELS_DIR)

    missing = [c for c in model.features if c not in df.columns]
    if missing:
        raise ValueError(f"Model feature'ları veride yok: {missing}")

    X = df[model.features]
    probs, matrix = model.predict_markets(X)
    scores = top_scores(matrix)
    lam_home, lam_away = model.lambdas(X)

    now = pd.Timestamp.utcnow().tz_localize(None)
    out = []
    for pos, (_, row) in enumerate(df.iterrows()):
        out.append({
            "id": row["match_id"],
            "league": row["league"],
            "kickoff": row["datetime"].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "time_confirmed": bool(
                (row["datetime"] - now) <= pd.Timedelta(days=TIME_CONFIRMED_DAYS)
            ),
            "home": {
                "id": row["home_id"], "name": row["home_team"],
                "short": row["home_short"], "elo": round(float(row["home_elo"])),
            },
            "away": {
                "id": row["away_id"], "name": row["away_team"],
                "short": row["away_short"], "elo": round(float(row["away_elo"])),
            },
            "lambdas": [round(float(lam_home[pos]), 3), round(float(lam_away[pos]), 3)],
            "markets": {
                key: [round(float(v), 4) for v in probs[key][pos]]
                for key in probs
            },
            "top_scores": [
                {"home": s["home"], "away": s["away"], "prob": round(s["prob"], 4)}
                for s in scores[pos]
            ],
        })
    return out


def main() -> int:
    df = load_features()
    matches = upcoming(df)
    if matches.empty:
        print("Tahmin penceresinde maç yok.")
        return 0

    predictions = predict(matches)
    for p in predictions[:15]:
        home, draw, away = (v * 100 for v in p["markets"]["result"])
        over = p["markets"]["over_2_5"][1] * 100
        btts = p["markets"]["btts"][1] * 100
        print(
            f"{p['kickoff'][:16].replace('T', ' ')}  "
            f"{p['home']['name'][:18]:18s} - {p['away']['name'][:18]:18s}  "
            f"1:%{home:.0f} X:%{draw:.0f} 2:%{away:.0f}  "
            f"Üst:%{over:.0f}  KG:%{btts:.0f}"
        )
    print(f"\n{len(predictions)} maç tahmin edildi "
          f"({PREDICT_WINDOW_DAYS} günlük pencere).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
