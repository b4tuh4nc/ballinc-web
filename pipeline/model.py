"""Gol beklentisi modeli ve skor matrisi.

Tek bir şey tahmin ediliyor: her takımın beklenen gol sayısı (λ). Bütün
marketler o λ'lardan kurulan Poisson skor matrisinden türetiliyor.

Bunun eski sistemdeki üç bağımsız modele göre iki avantajı var:
  * Tahminler birbiriyle çelişemez. Üç ayrı model "ev sahibi kazanır" +
    "2.5 alt" + "karşılıklı gol var" diyebiliyordu; bu kombinasyon
    neredeyse imkânsızdır.
  * Skor dağılımı, 1.5/3.5 alt-üst ve toplam gol beklentisi ek maliyet
    olmadan çıkıyor.

Düşük skorlarda saf Poisson 0-0, 1-0, 0-1 ve 1-1'i sistematik olarak yanlış
tahmin eder; Dixon-Coles düzeltmesi (rho) bunu telafi eder ve rho eğitim
verisinden fit edilir.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import poisson

from pipeline.config import MAX_GOALS

DEFAULT_PARAMS = dict(
    n_estimators=350,
    learning_rate=0.03,
    max_depth=3,
    subsample=0.8,
    colsample_bytree=0.7,
    min_child_weight=25,
    reg_lambda=3.0,
    objective="count:poisson",
    random_state=42,
)

LAMBDA_CLIP = (0.15, 5.0)
RHO_GRID = np.round(np.arange(-0.20, 0.081, 0.005), 4)

OU_LINES = (1.5, 2.5, 3.5)


# ─── Skor matrisi ────────────────────────────────────────────────────────────

def score_matrix(lam_home: np.ndarray, lam_away: np.ndarray, rho: float) -> np.ndarray:
    """(n, MAX_GOALS, MAX_GOALS) olasılık matrisi. [i, j] = i-j skoru."""
    lam_home = np.asarray(lam_home, dtype=float)
    lam_away = np.asarray(lam_away, dtype=float)
    goals = np.arange(MAX_GOALS)

    ph = poisson.pmf(goals[None, :], lam_home[:, None])
    pa = poisson.pmf(goals[None, :], lam_away[:, None])
    matrix = ph[:, :, None] * pa[:, None, :]

    # Dixon-Coles düşük skor düzeltmesi
    tau = np.ones_like(matrix)
    tau[:, 0, 0] = 1.0 - lam_home * lam_away * rho
    tau[:, 0, 1] = 1.0 + lam_home * rho
    tau[:, 1, 0] = 1.0 + lam_away * rho
    tau[:, 1, 1] = 1.0 - rho
    matrix = np.clip(matrix * tau, 1e-12, None)

    return matrix / matrix.sum(axis=(1, 2), keepdims=True)


def markets(matrix: np.ndarray) -> dict[str, np.ndarray]:
    """Skor matrisinden bütün market olasılıkları."""
    i = np.arange(MAX_GOALS)[:, None]
    j = np.arange(MAX_GOALS)[None, :]

    out = {
        "result": np.stack([
            (matrix * (i > j)).sum(axis=(1, 2)),
            (matrix * (i == j)).sum(axis=(1, 2)),
            (matrix * (i < j)).sum(axis=(1, 2)),
        ], axis=1),
        "btts": np.stack([
            (matrix * ((i == 0) | (j == 0))).sum(axis=(1, 2)),
            (matrix * ((i > 0) & (j > 0))).sum(axis=(1, 2)),
        ], axis=1),
    }
    for line in OU_LINES:
        over = (matrix * ((i + j) > line)).sum(axis=(1, 2))
        key = f"over_{str(line).replace('.', '_')}"
        out[key] = np.stack([1.0 - over, over], axis=1)
    return out


def scenario(matrix: np.ndarray) -> list[dict]:
    """Birlikte tutarlı olan en olası (1X2, 2.5 Alt/Üst, KG) üçlüsü.

    Marketler tek tek en olası seçeneğine bakılarak gösterildiğinde ortaya
    kendi kendini çürüten üçlüler çıkıyordu. En sık görüleni "1 / 2.5 Alt /
    KG Var"dı: iki takım da gol atmış ve toplam 2'yi geçmemişse skor
    zorunlu olarak 1-1'dir, yani beraberlik — "1" ile bir arada imkânsız.
    Ölçtüğümde 1.119 maçın 256'sı (%23) bu durumdaydı.

    Her marketin kendi olasılığı doğruydu; hata onları BİRLİKTE sunmaktaydı.
    Marjinal olasılıklar bağımsız seçilemez, çünkü aynı ortak dağılımdan
    geliyorlar. Burada sekiz kombinasyonun ortak olasılığı doğrudan skor
    matrisinden hesaplanıp en yükseği seçiliyor; sonuç tanımı gereği
    tutarlı.
    """
    i = np.arange(MAX_GOALS)[:, None]
    j = np.arange(MAX_GOALS)[None, :]
    result_masks = [(i > j), (i == j), (i < j)]
    over_masks = [((i + j) <= 2.5), ((i + j) > 2.5)]
    btts_masks = [((i == 0) | (j == 0)), ((i > 0) & (j > 0))]

    combos = []
    for r, r_mask in enumerate(result_masks):
        for o, o_mask in enumerate(over_masks):
            for b, b_mask in enumerate(btts_masks):
                mask = r_mask & o_mask & b_mask
                combos.append((r, o, b, (matrix * mask).sum(axis=(1, 2))))

    probs = np.stack([c[3] for c in combos], axis=1)
    best = probs.argmax(axis=1)

    # Senaryonun İÇİNDEKİ en olası skor. Ayrı hesaplanan "en olası skor"
    # senaryoyla çelişebiliyordu: sonuç 1-1 çıkarken üstteki cümle
    # "ev sahibi kazanır" diyordu. Aynı maskeden seçilince çelişemez.
    out = []
    for row, k in enumerate(best):
        r, o, b, _ = combos[k]
        mask = result_masks[r] & over_masks[o] & btts_masks[b]
        cell = np.where(mask, matrix[row], -1.0)
        flat = int(cell.argmax())
        out.append({
            "result": int(r),
            "over": int(o),
            "btts": int(b),
            "prob": float(probs[row, k]),
            "score": [flat // MAX_GOALS, flat % MAX_GOALS],
            "score_prob": float(cell.reshape(-1)[flat]),
        })
    return out


def top_scores(matrix: np.ndarray, n: int = 6) -> list[list[dict]]:
    """Maç başına en olası n skor."""
    flat = matrix.reshape(len(matrix), -1)
    idx = np.argsort(-flat, axis=1)[:, :n]
    results = []
    for row, cols in enumerate(idx):
        results.append([
            {
                "home": int(c // MAX_GOALS),
                "away": int(c % MAX_GOALS),
                "prob": float(flat[row, c]),
            }
            for c in cols
        ])
    return results


def _dc_loglik(matrix: np.ndarray, home_goals: np.ndarray, away_goals: np.ndarray) -> float:
    h = np.clip(home_goals.astype(int), 0, MAX_GOALS - 1)
    a = np.clip(away_goals.astype(int), 0, MAX_GOALS - 1)
    return float(np.log(matrix[np.arange(len(h)), h, a]).sum())


def fit_rho(lam_home: np.ndarray, lam_away: np.ndarray,
            home_goals: np.ndarray, away_goals: np.ndarray) -> float:
    """Dixon-Coles rho'sunu gözlenen skorların olabilirliğini maksimize ederek seçer."""
    best_rho, best_ll = 0.0, -np.inf
    for rho in RHO_GRID:
        ll = _dc_loglik(score_matrix(lam_home, lam_away, float(rho)), home_goals, away_goals)
        if ll > best_ll:
            best_rho, best_ll = float(rho), ll
    return best_rho


# ─── Model ───────────────────────────────────────────────────────────────────

class GoalModel:
    """İki Poisson regresörü (ev golü, deplasman golü) + Dixon-Coles rho."""

    def __init__(self, params: dict | None = None):
        self.params = {**DEFAULT_PARAMS, **(params or {})}
        self.home = xgb.XGBRegressor(**self.params)
        self.away = xgb.XGBRegressor(**self.params)
        self.rho = 0.0
        self.features: list[str] = []

    def fit(self, X: pd.DataFrame, home_goals, away_goals) -> "GoalModel":
        self.features = list(X.columns)
        self.home.fit(X, home_goals)
        self.away.fit(X, away_goals)
        lam_home, lam_away = self.lambdas(X)
        self.rho = fit_rho(lam_home, lam_away,
                           np.asarray(home_goals), np.asarray(away_goals))
        return self

    def lambdas(self, X: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        X = X[self.features]
        return (
            np.clip(self.home.predict(X), *LAMBDA_CLIP),
            np.clip(self.away.predict(X), *LAMBDA_CLIP),
        )

    def predict_markets(self, X: pd.DataFrame) -> tuple[dict[str, np.ndarray], np.ndarray]:
        lam_home, lam_away = self.lambdas(X)
        matrix = score_matrix(lam_home, lam_away, self.rho)
        return markets(matrix), matrix

    # ─── Kalıcılık ───────────────────────────────────────────────────────
    # Pickle değil JSON: pickle xgboost sürümü değişince sessizce bozulur,
    # eski projede modeller bu yüzden sürüme kilitliydi.

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.home.save_model(directory / "goals_home.json")
        self.away.save_model(directory / "goals_away.json")
        (directory / "model_meta.json").write_text(
            json.dumps({"rho": self.rho, "features": self.features,
                        "params": self.params}, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, directory: Path) -> "GoalModel":
        meta = json.loads((directory / "model_meta.json").read_text(encoding="utf-8"))
        obj = cls(meta["params"])
        obj.home.load_model(directory / "goals_home.json")
        obj.away.load_model(directory / "goals_away.json")
        obj.rho = meta["rho"]
        obj.features = meta["features"]
        return obj
