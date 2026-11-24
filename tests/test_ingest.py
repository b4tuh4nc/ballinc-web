from pathlib import Path

import pandas as pd

from pipeline import ingest
from pipeline.sources import fotmob, understat


def test_understat_outage_uses_fotmob_fallback(monkeypatch, capsys):
    fallback = pd.DataFrame({"is_result": [True], "has_xg": [False]})
    written = []

    def unavailable(*args):
        raise understat.UnderstatUnavailableError("empty response")

    monkeypatch.setattr(understat, "fetch_league_season", unavailable)
    monkeypatch.setattr(fotmob, "fetch_league_season", lambda *args: fallback)
    monkeypatch.setattr(ingest, "canonicalise", lambda df, league: df)
    monkeypatch.setattr(ingest, "_write_atomic",
                        lambda df, path: written.append((df, path)))
    monkeypatch.setattr(ingest, "raw_path", lambda *args: Path("fallback.parquet"))

    assert ingest.ingest_understat(["EPL"], ["2025_2026"]) == 0
    assert len(written) == 1
    assert written[0][0] is fallback
    assert written[0][1] == Path("fallback.parquet")
    assert "FotMob (yedek)" in capsys.readouterr().out


def test_understat_and_fotmob_fail_the_ingest(monkeypatch):
    def unavailable(*args):
        raise understat.UnderstatUnavailableError("empty response")

    def fallback_unavailable(*args):
        raise fotmob.FotmobError("source unavailable")

    monkeypatch.setattr(understat, "fetch_league_season", unavailable)
    monkeypatch.setattr(fotmob, "fetch_league_season", fallback_unavailable)

    assert ingest.ingest_understat(["EPL"], ["2025_2026"]) == 1
