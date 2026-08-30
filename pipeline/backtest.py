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


def run(df: pd.DataFrame, test_seasons: list[str]) -> tuple[
        pd.DataFrame, pd.DataFrame, list[dict], list[dict]]:
    cols = features.feature_columns(df)
    played = df[df["result"].notna()].copy()
    rows: list[dict] = []
    per_league: list[dict] = []
    verdict_probs: list[np.ndarray] = []
    verdict_y: list[np.ndarray] = []
    verdict_gap: list[np.ndarray] = []

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
        verdict_probs.append(probs["result"])
        verdict_y.append(test["result"].to_numpy().astype(int))
        verdict_gap.append((test["home_elo"] - test["away_elo"]).abs().to_numpy())

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

            # Lig kırılımı: xG'si olmayan ligler (TSL) gerçekten daha mı
            # zayıf tahmin ediliyor? Site bu rakamı gösteriyor.
            for league, idx in test.groupby("league").groups.items():
                pos = test.index.get_indexer(idx)
                y_lg = y_test[pos]
                if len(y_lg) < 30:
                    continue
                lg_stats = evaluate(y_lg, probs[target][pos], n_classes)
                lg_base = evaluate(
                    y_lg, prior_baseline(y_train, len(y_lg), n_classes), n_classes
                )
                per_league.append({
                    "league": league, "market": label, "n": lg_stats["n"],
                    "logloss": lg_stats["logloss"],
                    "baseline_ll": lg_base["logloss"],
                    "kazanç": 1 - lg_stats["logloss"] / lg_base["logloss"],
                    "acc": lg_stats["acc"], "baseline_acc": lg_base["acc"],
                })
        print(f"  ✓ {season}: {len(train)} maç ile eğitildi, {len(test)} maç test edildi "
              f"(rho={model.rho:+.3f})")

    if verdict_probs:
        all_p = np.vstack(verdict_probs)
        all_y = np.concatenate(verdict_y)
        confidence = confidence_table(all_p, all_y)
        elo_gaps = elo_gap_table(np.concatenate(verdict_gap), all_p, all_y)
    else:
        confidence, elo_gaps = [], []
    return pd.DataFrame(rows), pd.DataFrame(per_league), confidence, elo_gaps


# Site "Barcelona kazanır" gibi bir cümle kuruyor. O cümlenin ne kadar
# tuttuğu uydurulamaz: burada ölçülüp metrics.json'a yazılıyor ve site
# ölçülen rakamı gösteriyor.
#
# İki ifade ölçülüyor:
#   tek   — model en olası dediği sonucu tutturdu mu
#   çifte — favori (ev/dep arasında yüksek olan) kaybetmedi mi
#
# Ayrım şuradan çıktı: modelin güveni %50'nin altındayken tek seçim %44
# tutuyor, "favori kaybetmez" ise %72. Bilmediği yerde bildiğini iddia
# etmemek için site o maçlarda ikincisini söylüyor.
# Ust dilim ikiye bolundu: %60-100 tek dilimken %83 guvenli bir mac icin
# "bu tahmin %70 tuttu" deniyordu, oysa dilimin ustunde isabet cok daha
# yuksek. Not artik maca daha yakin bir rakam gosteriyor.
CONFIDENCE_BANDS = [(0.0, 0.50), (0.50, 0.60), (0.60, 0.72), (0.72, 1.01)]


def confidence_table(probs: np.ndarray, y: np.ndarray) -> list[dict]:
    conf = probs.max(axis=1)
    # Beraberlik hiçbir zaman en olası sonuç değil (Poisson matrisinde
    # olasılığı %33'ü aşamıyor), dolayısıyla favori ev ya da deplasman.
    fav = np.where(probs[:, 0] >= probs[:, 2], 0, 2)
    single = probs.argmax(axis=1) == y
    survives = y != np.where(fav == 0, 2, 0)
    p_survives = probs[np.arange(len(y)), fav] + probs[:, 1]

    out = []
    for lo, hi in CONFIDENCE_BANDS:
        m = (conf >= lo) & (conf < hi)
        if m.sum() < 100:
            continue
        out.append({
            "lo": lo, "hi": min(hi, 1.0), "n": int(m.sum()),
            "single": round(float(single[m].mean()), 4),
            "double": round(float(survives[m].mean()), 4),
            "double_said": round(float(p_survives[m].mean()), 4),
        })
    return out


# Modelin kaybı tek bir yerde yoğunlaşıyor: denk maçlarda. Site bunu
# gösteriyor çünkü "%53 isabet" tek başına yanıltıcı — maçların yarısında
# model çok iyi, diğer yarısında neredeyse hiçbir şey bilmiyor.
#
# Taban olarak DİLİMİN KENDİ sonuç dağılımı kullanılıyor, eğitim priorı
# değil: soru "bu dilim ne kadar öngörülebilir" değil, "model bu dilimde
# taban orandan ne kadar iyi".
ELO_BANDS = [(0, 40), (40, 100), (100, 200), (200, 10_000)]


def elo_gap_table(gaps: np.ndarray, probs: np.ndarray, y: np.ndarray) -> list[dict]:
    out = []
    for lo, hi in ELO_BANDS:
        m = (gaps >= lo) & (gaps < hi)
        if m.sum() < 200:
            continue
        p = np.clip(probs[m], 1e-9, 1)
        yy = y[m]
        ll = float(-np.mean(np.log(p[np.arange(len(yy)), yy])))
        share = np.bincount(yy, minlength=3) / len(yy)
        base = float(-np.mean(np.log(np.clip(share[yy], 1e-9, 1))))
        out.append({
            "lo": lo, "hi": None if hi > 9_999 else hi, "n": int(m.sum()),
            "logloss": round(ll, 4), "baseline_logloss": round(base, 4),
            "skill": round(1 - ll / base, 4),
            "accuracy": round(float((p.argmax(axis=1) == yy).mean()), 4),
        })
    return out


def summarise_leagues(per_league: pd.DataFrame) -> pd.DataFrame:
    """Lig × market kırılımını sezonlar boyunca ağırlıklı birleştirir."""
    if per_league.empty:
        return per_league
    out = []
    for (league, market), group in per_league.groupby(["league", "market"], sort=False):
        w = group["n"].to_numpy()
        out.append({
            "lig": league,
            "market": market,
            "n": int(w.sum()),
            "logloss": float(np.average(group["logloss"], weights=w)),
            "baseline_ll": float(np.average(group["baseline_ll"], weights=w)),
            "kazanç": float(np.average(group["kazanç"], weights=w)),
            "acc": float(np.average(group["acc"], weights=w)),
            "baseline_acc": float(np.average(group["baseline_acc"], weights=w)),
        })
    return pd.DataFrame(out).sort_values(["market", "kazanç"], ascending=[True, False])


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


def write_metrics(results: pd.DataFrame, summary: pd.DataFrame,
                  leagues: pd.DataFrame, confidence: list[dict],
                  elo_gaps: list[dict]) -> None:
    """Ölçümü models/metrics.json'a yazar; site bunu okuyup gösterir.

    Eski projedeki accuracy.json sadece çıplak doğruluk oranı tutuyordu ve
    "%55 üst tahmini" gibi yanıltıcı rakamlar üretiyordu. Burada her market,
    baseline'ıyla ve güvenilir sayılıp sayılmadığıyla birlikte kaydediliyor.
    """
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": "walk-forward: her sezon, kendisinden önceki maçlarla eğitildi",
        "markets": {},
        "leagues": {},
        "confidence": confidence,
        "elo_gaps": elo_gaps,
        "folds": json.loads(results.to_json(orient="records")),
    }
    for row in leagues.itertuples(index=False) if not leagues.empty else []:
        target = next(t for label, (t, _, _) in MARKETS.items() if label == row.market)
        payload["leagues"].setdefault(row.lig, {})[target] = {
            "n": int(row.n),
            "logloss": round(float(row.logloss), 4),
            "baseline_logloss": round(float(row.baseline_ll), 4),
            "skill": round(float(row.kazanç), 4),
            "accuracy": round(float(row.acc), 4),
            "reliable": bool(row.kazanç >= SKILL_THRESHOLD),
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
    results, per_league, confidence, elo_gaps = run(df, args.seasons)
    if results.empty:
        print("Değerlendirilecek sezon yok.")
        return 1

    summary = summarise(results)
    leagues = summarise_leagues(per_league)

    print("\n─── Sezon bazında ───")
    print(_fmt(results))
    print("\n─── Toplam (maç sayısına göre ağırlıklı) ───")
    print(_fmt(summary))
    if not leagues.empty:
        print("\n─── Lig bazında (1X2) ───")
        print(_fmt(leagues[leagues["market"] == "1X2"].drop(columns=["market"])))
    print(
        "\nlogloss düşük = iyi. 'kazanç' = baseline'a göre logloss iyileşmesi;\n"
        f"%{SKILL_THRESHOLD * 100:.0f} altındaysa market güvenilir sayılmıyor."
    )

    write_metrics(results, summary, leagues, confidence, elo_gaps)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
