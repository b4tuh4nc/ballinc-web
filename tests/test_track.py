"""Tahmin takibinin doğru skorladığını ve geçmişi değiştirmediğini doğrular."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from pipeline import track


def make_prediction(match_id: str, result_probs, over_probs, btts_probs) -> dict:
    return {
        "id": match_id,
        "league": "EPL",
        "kickoff": "2026-08-01T15:00:00Z",
        "home": {"name": "A takımı"},
        "away": {"name": "B takımı"},
        "markets": {
            "result": result_probs,
            "over_2_5": over_probs,
            "btts": btts_probs,
        },
    }


@pytest.fixture()
def conn(tmp_path):
    connection = track.connect(tmp_path / "test.sqlite")
    yield connection
    connection.close()


def test_record_and_settle_scores_correctly(conn) -> None:
    track.record(conn, [make_prediction("m1", [0.6, 0.25, 0.15], [0.3, 0.7], [0.4, 0.6])])

    # Gerçek sonuç: ev sahibi kazandı (0), 3 gol (üst=1), karşılıklı gol var (1)
    played = pd.DataFrame([{
        "match_id": "m1", "result": 0.0, "over_2_5": 1.0, "btts": 1.0,
    }])
    assert track.settle(conn, played) == 3

    rows = dict(conn.execute(
        "SELECT market, correct FROM predictions"
    ).fetchall())
    assert rows == {"result": 1, "over_2_5": 1, "btts": 1}

    logloss = dict(conn.execute("SELECT market, logloss FROM predictions").fetchall())
    assert logloss["result"] == pytest.approx(-np.log(0.6), rel=1e-6)
    assert logloss["over_2_5"] == pytest.approx(-np.log(0.7), rel=1e-6)


def test_wrong_pick_is_marked_wrong(conn) -> None:
    track.record(conn, [make_prediction("m2", [0.2, 0.3, 0.5], [0.8, 0.2], [0.7, 0.3])])
    played = pd.DataFrame([{
        "match_id": "m2", "result": 0.0, "over_2_5": 1.0, "btts": 1.0,
    }])
    track.settle(conn, played)

    rows = dict(conn.execute("SELECT market, correct FROM predictions").fetchall())
    assert rows == {"result": 0, "over_2_5": 0, "btts": 0}


def test_settled_predictions_are_immutable(conn) -> None:
    """Sonuçlanmış bir tahmin sonradan güncellenememeli."""
    track.record(conn, [make_prediction("m3", [0.6, 0.25, 0.15], [0.3, 0.7], [0.4, 0.6])])
    played = pd.DataFrame([{
        "match_id": "m3", "result": 2.0, "over_2_5": 0.0, "btts": 0.0,
    }])
    track.settle(conn, played)

    before = conn.execute(
        "SELECT probs FROM predictions WHERE market='result'"
    ).fetchone()[0]

    # Maç oynandıktan sonra "daha iyi" bir tahmin yazmayı dene.
    track.record(conn, [make_prediction("m3", [0.1, 0.1, 0.8], [0.5, 0.5], [0.5, 0.5])])

    after = conn.execute(
        "SELECT probs FROM predictions WHERE market='result'"
    ).fetchone()[0]
    assert after == before, "sonuçlanmış tahmin değiştirilebiliyor"
    assert json.loads(after) == [0.6, 0.25, 0.15]


def test_unsettled_predictions_are_updated(conn) -> None:
    """Maç oynanmadan önce tahmin tazelenebilmeli."""
    track.record(conn, [make_prediction("m4", [0.5, 0.3, 0.2], [0.5, 0.5], [0.5, 0.5])])
    track.record(conn, [make_prediction("m4", [0.7, 0.2, 0.1], [0.4, 0.6], [0.4, 0.6])])

    probs = conn.execute(
        "SELECT probs FROM predictions WHERE market='result'"
    ).fetchone()[0]
    assert json.loads(probs) == [0.7, 0.2, 0.1]


def test_settle_handles_missing_market_probs(conn) -> None:
    """Piyasa olasılığı olmayan tahminler sonuçlanabilmeli.

    pandas, NULL sütunu NaN olarak veriyor ve NaN truthy olduğu için basit
    bir doğruluk kontrolü onu string sanıp json.loads'a düşürüyordu; gecelik
    akış bu yüzden çöküyordu.
    """
    track.record(conn, [make_prediction("m9", [0.5, 0.3, 0.2], [0.4, 0.6], [0.4, 0.6])])
    assert conn.execute(
        "SELECT market_probs FROM predictions WHERE market='result'"
    ).fetchone()[0] is None

    played = pd.DataFrame([{
        "match_id": "m9", "result": 0.0, "over_2_5": 1.0, "btts": 1.0,
    }])
    assert track.settle(conn, played) == 3

    loss = conn.execute(
        "SELECT market_logloss FROM predictions WHERE market='result'"
    ).fetchone()[0]
    assert loss is None


def test_summary_reports_baseline(conn) -> None:
    # Üç maçın ikisini ev sahibi kazanıyor; baseline isabet 2/3 olmalı.
    for i, outcome in enumerate([0.0, 0.0, 2.0]):
        track.record(conn, [make_prediction(f"s{i}", [0.6, 0.25, 0.15], [0.3, 0.7], [0.4, 0.6])])
        track.settle(conn, pd.DataFrame([{
            "match_id": f"s{i}", "result": outcome, "over_2_5": 1.0, "btts": 1.0,
        }]))

    report = track.summary(conn)
    result = report["markets"]["result"]
    assert result["n"] == 3
    assert result["accuracy"] == pytest.approx(2 / 3, abs=1e-4)
    assert result["baseline_accuracy"] == pytest.approx(2 / 3, abs=1e-4)
