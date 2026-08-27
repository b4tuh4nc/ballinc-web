"""Walk-forward backtest — modelin gerçekten bir şey bilip bilmediğini ölçer.

Her test sezonu için model, o sezon başlamadan ÖNCE oynanmış maçlarla
eğitilir. Tek bir %80/%20 kesme yerine bunu yapmanın sebebi: gerçek kullanım
tam olarak böyle işliyor (elimizde geçmiş var, geleceği tahmin ediyoruz).

Her sonucun yanında naive baseline duruyor. Eski sistemin "%55 doğruluk"
iddiası, "her maça üst de" demenin %52 verdiği bir markette anlamsızdı;
buradaki tablo bu tür yanılsamayı imkânsız kılıyor.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.metrics import log_loss

from pipeline import features
from pipeline.config import MODELS_DIR, PROCESSED_DIR, SEASONS
from pipeline.model import GoalModel

MARKETS = {
    "1X2":        ("result", 3, ["1", "X", "2"]),
    "2.5 Alt/Üst": ("over_2_5", 2, ["Alt", "Üst"]),
    "KG Var/Yok":  ("btts", 2, ["Yok", "Var"]),
}

# Baseline'a göre logloss iyileşmesi bu eşiğin altındaysa market "bilgi
# taşımıyor" sayılır ve sitede uyarıyla gösterilir. Ölçümde 1X2 %7 civarı
# kazanç veriyor; 2.5 Alt/Üst ve KG ise sıfıra yakın.
SKILL_THRESHOLD = 0.02


def brier(y_true: np.ndarray, proba: np.ndarray, n_classes: int) -> float:
    onehot = np.zeros_like(proba)
    onehot[np.arange(len(y_true)), y_true.astype(int)] = 1.0
    return float(((proba - onehot) ** 2).sum(axis=1).mean())


def evaluate(y_true: np.ndarray, proba: np.ndarray, n_classes: int) -> dict:
    labels = list(range(n_classes))
    return {
        "n": len(y_true),
        "logloss": log_loss(y_true, proba, labels=labels),
        "brier": brier(y_true, proba, n_classes),
        "acc": float((proba.argmax(axis=1) == y_true).mean()),
    }


def prior_baseline(y_train: np.ndarray, n_test: int, n_classes: int) -> np.ndarray:
    counts = np.bincount(y_train.astype(int), minlength=n_classes).astype(float)
    return np.tile(counts / counts.sum(), (n_test, 1))


def run(df: pd.DataFrame, test_seasons: list[str]) -> pd.DataFrame:
    cols = features.feature_columns(df)
    played = df[df["result"].notna()].copy()
    rows = []

    for season in test_seasons:
        start = played.loc[played["season"] == season, "datetime"].min()
        if pd.isna(start):
            continue

        train = played[played["datetime"] < start]
        test = played[played["season"] == season]
        if len(train) < 500 or len(test) < 50:
            print(f"  · {season}: yeterli veri yok (eğitim {len(train)}, test {len(test)})")
            continue

        model = GoalModel().fit(
            train[cols], train["home_goals"].to_numpy(), train["away_goals"].to_numpy()
        )
        probs, _ = model.predict_markets(test[cols])

        for label, (target, n_classes, _) in MARKETS.items():
            y_test = test[target].to_numpy()
            y_train = train[target].to_numpy()
            model_stats = evaluate(y_test, probs[target], n_classes)
            base_stats = evaluate(
                y_test, prior_baseline(y_train, len(y_test), n_classes), n_classes
            )
            rows.append({
                "sezon": season.replace("_", "/")[2:].replace("/20", "/"),
                "market": label,
                "n": model_stats["n"],
                "logloss": model_stats["logloss"],
                "baseline_ll": base_stats["logloss"],
                "kazanç": 1 - model_stats["logloss"] / base_stats["logloss"],
                "brier": model_stats["brier"],
                "baseline_brier": base_stats["brier"],
                "acc": model_stats["acc"],
                "baseline_acc": base_stats["acc"],
                "rho": model.rho,
            })
        print(f"  ✓ {season}: {len(train)} maç ile eğitildi, {len(test)} maç test edildi "
              f"(rho={model.rho:+.3f})")

    return pd.DataFrame(rows)


def summarise(results: pd.DataFrame) -> pd.DataFrame:
    """Sezonları maç sayısına göre ağırlıklı birleştirir."""
    out = []
    for market, group in results.groupby("market", sort=False):
        w = group["n"].to_numpy()
        out.append({
            "market": market,
            "n": int(w.sum()),
            "logloss": float(np.average(group["logloss"], weights=w)),
            "baseline_ll": float(np.average(group["baseline_ll"], weights=w)),
            "kazanç": float(np.average(group["kazanç"], weights=w)),
            "brier": float(np.average(group["brier"], weights=w)),
            "baseline_brier": float(np.average(group["baseline_brier"], weights=w)),
            "acc": float(np.average(group["acc"], weights=w)),
            "baseline_acc": float(np.average(group["baseline_acc"], weights=w)),
        })
    return pd.DataFrame(out)


def _fmt(df: pd.DataFrame) -> str:
    show = df.copy()
    for col in ("logloss", "baseline_ll", "brier", "baseline_brier"):
        if col in show:
            show[col] = show[col].map("{:.4f}".format)
    for col in ("acc", "baseline_acc"):
        if col in show:
            show[col] = (show[col] * 100).map("%{:.1f}".format)
    if "kazanç" in show:
        show["kazanç"] = (show["kazanç"] * 100).map("{:+.1f}%".format)
    if "rho" in show:
        show = show.drop(columns=["rho"])
    return show.to_string(index=False)


def write_metrics(results: pd.DataFrame, summary: pd.DataFrame) -> None:
    """Ölçümü models/metrics.json'a yazar; site bunu okuyup gösterir.

    Eski projedeki accuracy.json sadece çıplak doğruluk oranı tutuyordu ve
    "%55 üst tahmini" gibi yanıltıcı rakamlar üretiyordu. Burada her market,
    baseline'ıyla ve güvenilir sayılıp sayılmadığıyla birlikte kaydediliyor.
    """
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": "walk-forward: her sezon, kendisinden önceki maçlarla eğitildi",
        "markets": {},
        "folds": json.loads(results.to_json(orient="records")),
    }
    for label, (target, _, _) in MARKETS.items():
        row = summary[summary["market"] == label]
        if row.empty:
            continue
        row = row.iloc[0]
        payload["markets"][target] = {
            "label": label,
            "n": int(row["n"]),
            "logloss": round(float(row["logloss"]), 4),
            "baseline_logloss": round(float(row["baseline_ll"]), 4),
            "skill": round(float(row["kazanç"]), 4),
            "brier": round(float(row["brier"]), 4),
            "baseline_brier": round(float(row["baseline_brier"]), 4),
            "accuracy": round(float(row["acc"]), 4),
            "baseline_accuracy": round(float(row["baseline_acc"]), 4),
            "reliable": bool(row["kazanç"] >= SKILL_THRESHOLD),
        }

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    path = MODELS_DIR / "metrics.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nÖlçüm kaydedildi → {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Walk-forward backtest")
    parser.add_argument("--seasons", nargs="*", default=SEASONS[1:])
    args = parser.parse_args()

    path = PROCESSED_DIR / "features.parquet"
    df = pd.read_parquet(path) if path.exists() else features.build()

    print("Walk-forward backtest (her sezon, kendisinden önceki maçlarla eğitilir)\n")
    results = run(df, args.seasons)
    if results.empty:
        print("Değerlendirilecek sezon yok.")
        return 1

    summary = summarise(results)
    print("\n─── Sezon bazında ───")
    print(_fmt(results))
    print("\n─── Toplam (maç sayısına göre ağırlıklı) ───")
    print(_fmt(summary))
    print(
        "\nlogloss düşük = iyi. 'kazanç' = baseline'a göre logloss iyileşmesi;\n"
        f"%{SKILL_THRESHOLD * 100:.0f} altındaysa market güvenilir sayılmıyor."
    )

    write_metrics(results, summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
