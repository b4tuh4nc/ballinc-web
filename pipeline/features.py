"""Feature üretimi — eğitim ve tahmin için TEK kod yolu.

Tasarımın özü: oynanmış ve oynanmamış bütün maçlar aynı fonksiyondan geçer.
Her maç için feature'lar "o maçın başlama saatinden ÖNCEKİ son duruma" göre
`merge_asof` ile bağlanır. Oynanmış bir maç için bu, maç öncesi formudur;
oynanmamış bir maç için bugünkü formdur. İki durum arasında kod farkı yok.

Eski sistemde eğitim `shift(1).rolling(min_periods=5)`, servis ise
`tail(5).mean()` kullanıyordu; aynı takım eğitimde elenirken serviste
1 maçlık "5 maçlık form" alıyordu. Bu dosya o sınıf hatayı yapısal olarak
imkânsız kılıyor.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from pipeline.config import LEAGUES, SEASONS, raw_path

WINDOWS = (5, 10)
MIN_PERIODS = {5: 3, 10: 5}

# xG tabanlı atak/defans reytingi. Elo tek bir sayı ("bu takım ne kadar iyi")
# ama hücum ve savunma ayrı beceriler: 3-3 biten maçla 0-0 biten maç aynı
# Elo'yu üretebiliyor. Gol yerine xG kullanılıyor çünkü gol çok gürültülü.
# Ölçümde walk-forward kazancı %8.1'den %8.5'e çıkardı.
RATING_ALPHA = 0.06       # güncelleme hızı
RATING_FLOOR = 0.3        # bölme yaparken aşırı küçük değerlere karşı
LEAGUE_MU_ALPHA = 0.01    # lig ortalaması yavaş hareket etsin

ELO_START = 1500.0
ELO_K = 20.0
ELO_HOME_ADV = 60.0
ELO_SEASON_CARRY = 0.75  # sezon arası ortalamaya dönüş

STAT_COLS = ["gf", "ga", "xgf", "xga", "pts"]


# ─── Ham veri ────────────────────────────────────────────────────────────────

def load_raw() -> pd.DataFrame:
    """Bütün lig-sezonları tek DataFrame'de, kronolojik sırada."""
    frames = []
    for league in LEAGUES:
        for season in SEASONS:
            path = raw_path(league, season)
            if path.exists():
                frames.append(pd.read_parquet(path))
    if not frames:
        raise FileNotFoundError("data/raw boş. Önce `python -m pipeline.ingest`.")
    # Dosyalar farklı kaynaklardan geliyor; birleştirmeden önce tipleri
    # sabitlemezsek tamamen boş xG sütunları concat sırasında tip uyarısı
    # üretiyor ve ileride sessizce object'e düşebilir.
    for frame in frames:
        for col in ("home_goals", "away_goals", "home_xg", "away_xg"):
            frame[col] = pd.to_numeric(frame[col], errors="coerce").astype("float64")
        frame["round"] = pd.to_numeric(frame.get("round"), errors="coerce").astype("Int64")

    df = pd.concat(frames, ignore_index=True)
    df["datetime"] = pd.to_datetime(df["datetime"])
    return df.sort_values(["datetime", "match_id"]).reset_index(drop=True)


# ─── Takım-maç uzun formu ────────────────────────────────────────────────────

def _long_form(df: pd.DataFrame) -> pd.DataFrame:
    """Her maçı iki satıra açar: ev takımı ve deplasman takımı perspektifi."""
    home = df[["match_id", "datetime", "league", "season", "home_id",
               "home_goals", "away_goals", "home_xg", "away_xg"]].copy()
    home.columns = ["match_id", "datetime", "league", "season", "team",
                    "gf", "ga", "xgf", "xga"]
    home["is_home"] = True

    away = df[["match_id", "datetime", "league", "season", "away_id",
               "away_goals", "home_goals", "away_xg", "home_xg"]].copy()
    away.columns = ["match_id", "datetime", "league", "season", "team",
                    "gf", "ga", "xgf", "xga"]
    away["is_home"] = False

    long = pd.concat([home, away], ignore_index=True)
    long["played"] = long["gf"].notna()
    long["pts"] = np.where(
        long["gf"] > long["ga"], 3.0,
        np.where(long["gf"] == long["ga"], 1.0, 0.0),
    )
    long.loc[~long["played"], "pts"] = np.nan
    return long.sort_values(["team", "datetime"]).reset_index(drop=True)


def _team_state(long: pd.DataFrame, venue: str | None = None) -> pd.DataFrame:
    """Her oynanmış maçtan SONRAKİ takım durumunu hesaplar.

    Kaydırma (shift) yok — bu bilerek. Maç öncesi duruma geçiş `merge_asof`
    ile yapılıyor: bir maça, o maçtan kesinlikle önce biten son maçın
    durumu bağlanıyor. Böylece oynanmış ve oynanmamış maçlar için aynı
    mekanizma çalışıyor ve maçın kendi sonucu asla kendi feature'ına sızmıyor.
    """
    played = long[long["played"]]
    if venue == "home":
        played = played[played["is_home"]]
    elif venue == "away":
        played = played[~played["is_home"]]
    played = played.sort_values(["team", "datetime"])

    prefix = "v" if venue else ""
    out = played[["team", "datetime"]].copy()
    grouped = played.groupby("team", sort=False)
    for window in WINDOWS if venue is None else (5,):
        for col in STAT_COLS:
            out[f"{prefix}{col}_{window}"] = grouped[col].transform(
                lambda s, w=window: s.rolling(w, min_periods=MIN_PERIODS[w]).mean()
            )
    return out.sort_values("datetime").reset_index(drop=True)


def _attach(matches: pd.DataFrame, state: pd.DataFrame, side: str) -> pd.DataFrame:
    """Bir maça, ilgili takımın maçtan önceki son durumunu bağlar."""
    id_col = f"{side}_id"
    right = state.rename(columns={"team": id_col})
    value_cols = [c for c in right.columns if c not in (id_col, "datetime")]
    right = right.rename(columns={c: f"{side}_{c}" for c in value_cols})

    merged = pd.merge_asof(
        matches.sort_values("datetime"),
        right.sort_values("datetime"),
        on="datetime",
        by=id_col,
        direction="backward",
        allow_exact_matches=False,  # aynı anda başlayan maç durumu etkilemez
    )
    return merged


# ─── Elo ─────────────────────────────────────────────────────────────────────

def _elo(df: pd.DataFrame) -> pd.DataFrame:
    """Kronolojik Elo. Sadece oynanmış maçlar reyting günceller.

    Oynanmamış maçlar takımın o ana kadarki güncel reytingini alır, ki bu
    tahmin anında istediğimiz şeydir.
    """
    rating: dict[str, float] = {}
    season_of: dict[str, str] = {}
    home_out, away_out = [], []

    for row in df.itertuples(index=False):
        for team in (row.home_id, row.away_id):
            if team not in rating:
                rating[team] = ELO_START
                season_of[team] = row.season
            elif season_of[team] != row.season:
                # Yeni sezon: kadro değişir, güç farkları kısmen sıfırlanır.
                rating[team] = ELO_START + ELO_SEASON_CARRY * (rating[team] - ELO_START)
                season_of[team] = row.season

        rh, ra = rating[row.home_id], rating[row.away_id]
        home_out.append(rh)
        away_out.append(ra)

        if not row.is_result or pd.isna(row.home_goals):
            continue

        expected = 1.0 / (1.0 + 10 ** (-((rh + ELO_HOME_ADV) - ra) / 400.0))
        if row.home_goals > row.away_goals:
            actual = 1.0
        elif row.home_goals == row.away_goals:
            actual = 0.5
        else:
            actual = 0.0

        margin = abs(row.home_goals - row.away_goals)
        mult = 1.0 if margin <= 1 else (1.5 if margin == 2 else 1.75 + (margin - 3) / 8)
        delta = ELO_K * mult * (actual - expected)
        rating[row.home_id] = rh + delta
        rating[row.away_id] = ra - delta

    df = df.copy()
    df["home_elo"] = home_out
    df["away_elo"] = away_out
    df["elo_diff"] = df["home_elo"] - df["away_elo"] + ELO_HOME_ADV
    return df


def _xg_ratings(df: pd.DataFrame) -> pd.DataFrame:
    """Takım başına hücum ve savunma gücü, lig ortalamasına göre.

    Elo gibi kronolojik ve maç öncesi: her maça o maçtan önceki durum
    yazılıyor, sonuç kendi feature'ına sızmıyor. Güncelleme çarpımsal —
    zayıf savunmaya atılan gol, güçlü savunmaya atılandan az değer taşıyor.
    """
    attack: dict[str, float] = {}
    defence: dict[str, float] = {}
    league_mu: dict[str, float] = {}
    rows = {"home_att": [], "home_def": [], "away_att": [], "away_def": []}

    for r in df.itertuples(index=False):
        mu = league_mu.setdefault(r.league, 1.35)
        for team in (r.home_id, r.away_id):
            attack.setdefault(team, 1.0)
            defence.setdefault(team, 1.0)

        rows["home_att"].append(attack[r.home_id])
        rows["home_def"].append(defence[r.home_id])
        rows["away_att"].append(attack[r.away_id])
        rows["away_def"].append(defence[r.away_id])

        if pd.isna(r.home_xg) or pd.isna(r.away_xg):
            continue   # xG yoksa (Süper Lig) reyting güncellenmiyor

        ha, aa = attack[r.home_id], attack[r.away_id]
        hd, ad = defence[r.home_id], defence[r.away_id]
        attack[r.home_id] += RATING_ALPHA * ((r.home_xg / mu) / max(ad, RATING_FLOOR) - ha)
        defence[r.home_id] += RATING_ALPHA * ((r.away_xg / mu) / max(aa, RATING_FLOOR) - hd)
        attack[r.away_id] += RATING_ALPHA * ((r.away_xg / mu) / max(hd, RATING_FLOOR) - aa)
        defence[r.away_id] += RATING_ALPHA * ((r.home_xg / mu) / max(ha, RATING_FLOOR) - ad)
        league_mu[r.league] = mu + LEAGUE_MU_ALPHA * ((r.home_xg + r.away_xg) / 2 - mu)

    df = df.copy()
    for name, values in rows.items():
        df[name] = values
    # Ev sahibinin hücumu × rakibin savunma zayıflığı, ve tersi.
    df["att_edge"] = df["home_att"] * df["away_def"]
    df["def_edge"] = df["away_att"] * df["home_def"]
    return df


# ─── Ana giriş ───────────────────────────────────────────────────────────────

def build(df: pd.DataFrame | None = None) -> pd.DataFrame:
    """Ham maçlardan feature tablosu üretir (oynanmış + oynanmamış hepsi)."""
    if df is None:
        df = load_raw()
    df = df.sort_values(["datetime", "match_id"]).reset_index(drop=True)

    df = _elo(df)
    df = _xg_ratings(df)
    long = _long_form(df)

    for venue, sides in ((None, ("home", "away")), ("home", ("home",)), ("away", ("away",))):
        state = _team_state(long, venue)
        for side in sides:
            df = _attach(df, state, side)

    # Dinlenme günü ve sezon içi oynanmış maç sayısı
    played = long[long["played"]].sort_values(["team", "datetime"])
    prev = played[["team", "datetime", "season"]].copy()
    prev["last_played"] = prev["datetime"]
    prev["season_played"] = prev.groupby(["team", "season"]).cumcount() + 1
    prev = prev[["team", "datetime", "last_played", "season_played"]].sort_values("datetime")

    for side in ("home", "away"):
        df = _attach(df, prev, side)
        df[f"{side}_rest_days"] = (
            df["datetime"] - df[f"{side}_last_played"]
        ).dt.total_seconds() / 86400.0
        df = df.drop(columns=[f"{side}_last_played"])
        df[f"{side}_season_played"] = df[f"{side}_season_played"].fillna(0)

    # Hedefler (sadece oynanmış maçlarda dolu)
    played_mask = df["home_goals"].notna() & df["away_goals"].notna()
    total = df["home_goals"] + df["away_goals"]
    df["result"] = np.where(
        df["home_goals"] > df["away_goals"], 0,
        np.where(df["home_goals"] == df["away_goals"], 1, 2),
    ).astype(float)
    df.loc[~played_mask, "result"] = np.nan
    df["over_2_5"] = np.where(total > 2.5, 1.0, 0.0)
    df.loc[~played_mask, "over_2_5"] = np.nan
    df["btts"] = np.where((df["home_goals"] > 0) & (df["away_goals"] > 0), 1.0, 0.0)
    df.loc[~played_mask, "btts"] = np.nan

    df["league_code"] = df["league"].astype("category").cat.codes
    df["month"] = df["datetime"].dt.month
    return df.sort_values(["datetime", "match_id"]).reset_index(drop=True)


def feature_columns(df: pd.DataFrame) -> list[str]:
    """Modele girecek sütunlar. Hedefler ve kimlikler dışarıda kalır."""
    excluded = {
        "match_id", "datetime", "league", "season",
        "home_id", "away_id", "home_team", "away_team", "home_short", "away_short",
        "home_goals", "away_goals", "home_xg", "away_xg",
        "is_result", "has_xg", "result", "over_2_5", "btts",
        # Hafta numarası maç öncesi bilinir ama tahmin gücü yok; sitede
        # gruplama için taşınıyor, modele girmesi sadece gürültü ekler.
        "round",
    }
    return [
        c for c in df.columns
        if c not in excluded and pd.api.types.is_numeric_dtype(df[c])
    ]


def main() -> int:
    from pipeline.config import PROCESSED_DIR

    df = build()
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    out = PROCESSED_DIR / "features.parquet"
    df.to_parquet(out, index=False)

    played = int(df["result"].notna().sum())
    cols = feature_columns(df)
    print(f"{len(df)} maç ({played} oynanmış), {len(cols)} feature → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
