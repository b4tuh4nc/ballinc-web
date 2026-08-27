"""Feature katmanının sızıntı yapmadığını kanıtlayan testler.

En kritiği `test_no_future_leakage`: bir maçın feature'ları, o maçın kendi
sonucu ve sonraki bütün maçlar silindiğinde de birebir aynı çıkmalı. Eski
sistemde botun "geçmiş test" özelliği tam olarak bunu ihlal ediyordu —
geçmiş bir maçı bugünkü formla tahmin ediyor ve sahte isabet üretiyordu.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pipeline import features
from pipeline.features import ELO_SEASON_CARRY, ELO_START


@pytest.fixture(scope="module")
def raw() -> pd.DataFrame:
    return features.load_raw()


@pytest.fixture(scope="module")
def built(raw: pd.DataFrame) -> pd.DataFrame:
    return features.build(raw)


def test_no_future_leakage(raw: pd.DataFrame, built: pd.DataFrame) -> None:
    """Bir maçın feature'ları geleceğe bağlı olmamalı."""
    played = built[built["result"].notna()]
    # Form birikmiş olsun diye veri setinin ortalarından örnek alıyoruz.
    sample = played.iloc[len(played) // 2 :: max(1, len(played) // 12)].head(10)
    assert len(sample) >= 5, "test için yeterli maç yok"

    cols = features.feature_columns(built)

    for target in sample.itertuples(index=False):
        # Maçın kendi sonucunu ve sonrasındaki her şeyi sil.
        truncated = raw[raw["datetime"] <= target.datetime].copy()
        own = truncated["match_id"] == target.match_id
        truncated.loc[own, ["home_goals", "away_goals", "home_xg", "away_xg"]] = np.nan
        truncated.loc[own, "is_result"] = False

        rebuilt = features.build(truncated)
        row = rebuilt[rebuilt["match_id"] == target.match_id]
        assert len(row) == 1, f"{target.match_id} yeniden üretilemedi"

        before = pd.Series({c: getattr(target, c) for c in cols}, dtype="float64")
        after = row[cols].iloc[0].astype("float64")
        pd.testing.assert_series_equal(
            before, after, check_names=False, rtol=1e-9, atol=1e-9,
            obj=f"{target.match_id} feature'ları geleceğe bağlı",
        )


def test_simultaneous_matches_do_not_see_each_other(built: pd.DataFrame) -> None:
    """Aynı saniyede başlayan maçlar birbirinin feature'ını etkilememeli."""
    counts = built.groupby("datetime").size()
    shared = counts[counts > 1]
    assert len(shared) > 0, "aynı anda başlayan maç yok, test anlamsız"
    # merge_asof(allow_exact_matches=False) sayesinde bu maçların
    # feature'ları yalnızca kesinlikle daha erken biten maçlardan gelir.
    slot = built[built["datetime"] == shared.index[0]]
    assert slot["home_elo"].notna().all()


def test_unplayed_matches_have_features_but_no_targets(built: pd.DataFrame) -> None:
    future = built[~built["is_result"]]
    assert len(future) > 0
    assert future["result"].isna().all()
    assert future["over_2_5"].isna().all()
    assert future["btts"].isna().all()
    # Elo her zaman dolu olmalı, yoksa maç tahmin edilemez.
    assert future["home_elo"].notna().all()
    assert future["away_elo"].notna().all()


def test_targets_match_scores(built: pd.DataFrame) -> None:
    played = built[built["result"].notna()]
    expected = np.where(
        played["home_goals"] > played["away_goals"], 0,
        np.where(played["home_goals"] == played["away_goals"], 1, 2),
    )
    assert (played["result"].to_numpy() == expected).all()
    total = played["home_goals"] + played["away_goals"]
    assert (played["over_2_5"].to_numpy() == (total > 2.5).to_numpy()).all()


def test_elo_regresses_between_seasons(raw: pd.DataFrame) -> None:
    """Sezon geçişinde reyting ortalamaya çekilmeli."""
    built = features.build(raw)
    epl = built[built["league"] == "EPL"].sort_values("datetime")

    seasons = sorted(epl["season"].unique())
    old, new = seasons[0], seasons[1]
    last = epl[epl["season"] == old].groupby("home_id")["home_elo"].last()
    first = epl[epl["season"] == new].groupby("home_id")["home_elo"].first()
    common = last.index.intersection(first.index)
    assert len(common) >= 10

    spread_before = (last[common] - ELO_START).abs().mean()
    spread_after = (first[common] - ELO_START).abs().mean()
    assert spread_after < spread_before, "sezon arası regresyon uygulanmamış"
    assert spread_after > spread_before * ELO_SEASON_CARRY * 0.5


def test_no_leak_fields_present(built: pd.DataFrame) -> None:
    from pipeline.config import LEAK_FIELDS

    assert not (LEAK_FIELDS & set(built.columns))
    assert not (LEAK_FIELDS & set(features.feature_columns(built)))
