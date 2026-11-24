import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier, HistGradientBoostingRegressor, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression, RidgeClassifier, Ridge
from xgboost import XGBRegressor, XGBClassifier
from pipeline.model import DEFAULT_PARAMS
from pipeline.features import feature_columns
from sklearn.preprocessing import StandardScaler

def train_and_predict():
    df = pd.read_parquet("data/processed/features.parquet")
    
    df['datetime'] = pd.to_datetime(df['datetime'])
    cutoff = pd.to_datetime("2026-09-29").tz_localize(None)
    next_day = pd.to_datetime("2026-10-02").tz_localize(None)
    
    train_df = df[(df['datetime'] < cutoff) & (df['is_result'] == True)].copy()
    test_df = df[(df['datetime'] >= cutoff) & (df['datetime'] < next_day) & (df['is_result'] == True)].copy()
    
    if len(test_df) == 0:
        print("No matches found!")
        return

    feats = feature_columns(df)
    
    # Fill NAs
    X_train_raw = train_df[feats].fillna(0)
    X_test_raw = test_df[feats].fillna(0)
    
    # Scaling for linear models
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train_raw)
    X_test_scaled = scaler.transform(X_test_raw)
    
    # Regression targets
    y_home_train = train_df["home_goals"]
    y_away_train = train_df["away_goals"]
    
    # Classification targets (0=1, 1=X, 2=2) for easier training, we'll map back
    def get_res(h, a):
        if h > a: return 0
        if h < a: return 2
        return 1
        
    y_class_train = train_df.apply(lambda r: get_res(r['home_goals'], r['away_goals']), axis=1)
    
    # ---------------- REGRESSION MODELS ----------------
    print("Training Regressors...")
    # 1. XGBoost Regressor (Current)
    m_xgb_h = XGBRegressor(**DEFAULT_PARAMS).fit(X_train_raw, y_home_train)
    m_xgb_a = XGBRegressor(**DEFAULT_PARAMS).fit(X_train_raw, y_away_train)
    p_xgb_h = m_xgb_h.predict(X_test_raw)
    p_xgb_a = m_xgb_a.predict(X_test_raw)
    
    # 2. Random Forest Regressor
    m_rfr_h = RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1).fit(X_train_raw, y_home_train)
    m_rfr_a = RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1).fit(X_train_raw, y_away_train)
    p_rfr_h = m_rfr_h.predict(X_test_raw)
    p_rfr_a = m_rfr_a.predict(X_test_raw)
    
    # 3. Ridge Regressor (Linear)
    m_ridge_h = Ridge(alpha=1.0).fit(X_train_scaled, y_home_train)
    m_ridge_a = Ridge(alpha=1.0).fit(X_train_scaled, y_away_train)
    p_ridge_h = m_ridge_h.predict(X_test_scaled)
    p_ridge_a = m_ridge_a.predict(X_test_scaled)

    def likely_result(lh, la, threshold=0.2):
        if lh > la + threshold: return "1"
        if la > lh + threshold: return "2"
        return "X"

    pred_xgb_reg = [likely_result(h, a) for h, a in zip(p_xgb_h, p_xgb_a)]
    pred_rfr_reg = [likely_result(h, a) for h, a in zip(p_rfr_h, p_rfr_a)]
    pred_ridge_reg = [likely_result(h, a) for h, a in zip(p_ridge_h, p_ridge_a)]

    # ---------------- CLASSIFICATION MODELS ----------------
    print("Training Classifiers...")
    class_map = {0: "1", 1: "X", 2: "2"}
    
    # 4. Logistic Regression
    m_log = LogisticRegression(max_iter=1000).fit(X_train_scaled, y_class_train)
    pred_log = [class_map[x] for x in m_log.predict(X_test_scaled)]
    
    # 5. Random Forest Classifier
    m_rfc = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1).fit(X_train_raw, y_class_train)
    pred_rfc = [class_map[x] for x in m_rfc.predict(X_test_raw)]
    
    # 6. HistGradientBoosting Classifier (LightGBM equivalent in sklearn)
    m_hgb = HistGradientBoostingClassifier(random_state=42).fit(X_train_raw, y_class_train)
    pred_hgb = [class_map[x] for x in m_hgb.predict(X_test_raw)]

    # 7. XGBoost Classifier
    m_xgb_c = XGBClassifier(n_estimators=100, max_depth=4, learning_rate=0.1, random_state=42).fit(X_train_raw, y_class_train)
    pred_xgb_c = [class_map[x] for x in m_xgb_c.predict(X_test_raw)]

    # EVALUATION
    actuals = [class_map[get_res(r.home_goals, r.away_goals)] for r in test_df.itertuples()]
    
    models = {
        "XGB (Reg)": pred_xgb_reg,
        "RF (Reg)": pred_rfr_reg,
        "Ridge (Reg)": pred_ridge_reg,
        "Logistic (Class)": pred_log,
        "RF (Class)": pred_rfc,
        "HistGB (Class)": pred_hgb,
        "XGB (Class)": pred_xgb_c
    }
    
    correct_counts = {k: 0 for k in models.keys()}
    
    out = []
    header = "| Maç | Gerçek | " + " | ".join(models.keys()) + " |"
    out.append(header)
    out.append("|---" + "|---" * (len(models) + 1) + "|")
    
    for i, row in enumerate(test_df.itertuples()):
        match_name = f"{row.home_team} - {row.away_team}"
        actual = actuals[i]
        
        cols = [f"{match_name} ({int(row.home_goals)}-{int(row.away_goals)})", f"**{actual}**"]
        for m_name, preds in models.items():
            p = preds[i]
            if p == actual:
                correct_counts[m_name] += 1
                cols.append(f"**{p}**")
            else:
                cols.append(p)
        out.append("| " + " | ".join(cols) + " |")

    out.append("")
    out.append(f"### Doğru Tahmin Sayısı (Toplam {len(test_df)} maç)")
    for k, v in correct_counts.items():
        out.append(f"- **{k}:** {v} doğru")

    with open("compare_out.md", "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print("Done")

if __name__ == '__main__':
    train_and_predict()
