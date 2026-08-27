"""Tahmin geçmişi: her tahmini kaydeder, maç bitince sonuçla eşleştirir.

Eski projede `ballinc_results.db` içinde tam bu amaç için bir tablo vardı ama
hiçbir yerden yazılmıyordu — yani sistemin gerçekte ne kadar tuttuğu hiç
bilinmiyordu. Buradaki kayıt geriye dönük değiştirilemez: bir maç oynandıktan
sonra o maçın tahmini artık güncellenmiyor.

Skorlama için maç öncesi SON tahmin kullanılıyor; kullanıcının sitede gördüğü
şey de o olduğu için ölçüm dürüst oluyor.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from pipeline import features, predict as predict_mod
from pipeline.config import MODELS_DIR, PREDICTIONS_DB, WEB_DATA_DIR
from pipeline.model import GoalModel

MARKETS = {
    "result": ("1X2", ["1", "X", "2"], 3),
    "over_2_5": ("2.5 Alt/Üst", ["Alt", "Üst"], 2),
    "btts": ("KG Var/Yok", ["Yok", "Var"], 2),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS predictions (
    match_id     TEXT NOT NULL,
    market       TEXT NOT NULL,
    league       TEXT NOT NULL,
    kickoff      TEXT NOT NULL,
    home         TEXT NOT NULL,
    away         TEXT NOT NULL,
    probs        TEXT NOT NULL,
    pick         INTEGER NOT NULL,
    predicted_at TEXT NOT NULL,
    outcome      INTEGER,
    correct      INTEGER,
    logloss      REAL,
    settled_at   TEXT,
    PRIMARY KEY (match_id, market)
);
CREATE INDEX IF NOT EXISTS idx_settled ON predictions(settled_at);
"""


def connect(path=None) -> sqlite3.Connection:
    path = path or PREDICTIONS_DB
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    return conn


def record(conn: sqlite3.Connection, predictions: list[dict]) -> int:
    """Henüz oynanmamış maçların tahminlerini kaydeder/günceller.

    `settled_at IS NULL` koşulu kritik: sonuçlanmış bir tahmin bir daha
    değişmez, yoksa geçmişe dönük "düzeltme" yapılabilir hale gelirdi.
    """
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    for p in predictions:
        for market in MARKETS:
            probs = p["markets"][market]
            rows.append((
                p["id"], market, p["league"], p["kickoff"],
                p["home"]["name"], p["away"]["name"],
                json.dumps(probs), int(np.argmax(probs)), now,
            ))

    conn.executemany(
        """INSERT INTO predictions
             (match_id, market, league, kickoff, home, away, probs, pick, predicted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(match_id, market) DO UPDATE SET
             probs = excluded.probs,
             pick = excluded.pick,
             predicted_at = excluded.predicted_at,
             kickoff = excluded.kickoff
           WHERE predictions.settled_at IS NULL""",
        rows,
    )
    conn.commit()
    return len(rows)


def settle(conn: sqlite3.Connection, df: pd.DataFrame) -> int:
    """Oynanmış maçların tahminlerini gerçek sonuçla eşleştirir."""
    pending = pd.read_sql_query(
        "SELECT match_id, market, probs FROM predictions WHERE settled_at IS NULL",
        conn,
    )
    if pending.empty:
        return 0

    played = df[df["result"].notna()].set_index("match_id")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    updates = []

    for row in pending.itertuples(index=False):
        if row.match_id not in played.index:
            continue
        match = played.loc[row.match_id]
        outcome = int(match[row.market])
        probs = np.asarray(json.loads(row.probs), dtype=float)
        probs = np.clip(probs / probs.sum(), 1e-12, 1.0)
        updates.append((
            outcome,
            int(np.argmax(probs) == outcome),
            float(-np.log(probs[outcome])),
            now,
            row.match_id,
            row.market,
        ))

    conn.executemany(
        """UPDATE predictions
              SET outcome = ?, correct = ?, logloss = ?, settled_at = ?
            WHERE match_id = ? AND market = ? AND settled_at IS NULL""",
        updates,
    )
    conn.commit()
    return len(updates)


def summary(conn: sqlite3.Connection) -> dict:
    """Sitede gösterilecek doğrulanmış isabet özeti."""
    df = pd.read_sql_query(
        """SELECT market, league, outcome, correct, logloss, kickoff
             FROM predictions WHERE settled_at IS NOT NULL""",
        conn,
    )
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": int(len(df)),
        "markets": {},
    }
    if df.empty:
        return out

    for market, (label, names, n_classes) in MARKETS.items():
        sub = df[df["market"] == market]
        if sub.empty:
            continue
        # Baseline: bu maçlarda en sık görülen sonucu her seferinde söylemek.
        counts = sub["outcome"].value_counts(normalize=True)
        out["markets"][market] = {
            "label": label,
            "n": int(len(sub)),
            "accuracy": round(float(sub["correct"].mean()), 4),
            "baseline_accuracy": round(float(counts.iloc[0]), 4),
            "logloss": round(float(sub["logloss"].mean()), 4),
            "since": sub["kickoff"].min()[:10],
        }
    return out


def main() -> int:
    df = predict_mod.load_features()
    conn = connect()
    try:
        matches = predict_mod.upcoming(df)
        recorded = 0
        if not matches.empty:
            predictions = predict_mod.predict(matches, GoalModel.load(MODELS_DIR))
            recorded = record(conn, predictions)

        settled = settle(conn, df)
        report = summary(conn)

        WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
        (WEB_DATA_DIR / "accuracy.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        print(f"{recorded} tahmin kaydedildi, {settled} tahmin sonuçlandı.")
        if report["markets"]:
            print("\nDoğrulanmış isabet:")
            for m in report["markets"].values():
                print(f"  {m['label']:12s} {m['n']:4d} tahmin  "
                      f"isabet %{m['accuracy'] * 100:.1f} "
                      f"(baseline %{m['baseline_accuracy'] * 100:.1f})  "
                      f"logloss {m['logloss']:.4f}")
        else:
            print("Henüz sonuçlanmış tahmin yok — ilk maçlar oynandıkça dolacak.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
