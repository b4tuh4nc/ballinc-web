"""Son modeli oynanmış bütün maçlarla eğitir ve models/ altına kaydeder.

Modelin ne kadar iyi olduğu buradan öğrenilmez — bu model kendi eğitim
verisini görmüştür. Dürüst rakamlar `pipeline.backtest`'ten gelir ve
`models/metrics.json` içinde durur. Burası sadece "en güncel veriyle
üretim modelini kur" adımı.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pandas as pd

from pipeline import features
from pipeline.config import MODELS_DIR, PROCESSED_DIR
from pipeline.model import GoalModel


def main() -> int:
    path = PROCESSED_DIR / "features.parquet"
    df = pd.read_parquet(path) if path.exists() else features.build()

    played = df[df["result"].notna()].copy()
    cols = features.feature_columns(df)
    if len(played) < 500:
        print(f"Eğitim için yetersiz veri ({len(played)} maç).")
        return 1

    print(f"{len(played)} oynanmış maç, {len(cols)} feature ile eğitiliyor...")
    model = GoalModel().fit(
        played[cols], played["home_goals"].to_numpy(), played["away_goals"].to_numpy()
    )
    model.save(MODELS_DIR)

    lam_home, lam_away = model.lambdas(played[cols])
    print(
        f"  rho = {model.rho:+.3f}\n"
        f"  ortalama λ  ev {lam_home.mean():.3f} / dep {lam_away.mean():.3f}  "
        f"(gerçek {played['home_goals'].mean():.3f} / {played['away_goals'].mean():.3f})"
    )

    importance = (
        pd.Series(model.home.feature_importances_, index=cols)
        .sort_values(ascending=False)
        .head(10)
    )
    print("\nEn etkili 10 feature (ev golü modeli):")
    for name, value in importance.items():
        print(f"  {name:24s} {value:.4f}")

    (MODELS_DIR / "train_info.json").write_text(
        json.dumps({
            "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "matches": int(len(played)),
            "features": cols,
            "last_match": played["datetime"].max().isoformat(),
            "leagues": sorted(played["league"].unique().tolist()),
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nModel kaydedildi → {MODELS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
