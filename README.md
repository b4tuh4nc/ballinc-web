# Ballinc

Beş Avrupa ligi ve Süper Lig için xG tabanlı maç tahminleri sunan statik web sitesi.

Sistem iki bağımsız parçadan oluşur. Bu ayrım kasıtlıdır: veri çekimi bozulduğunda
site etkilenmez.

```
ARKA PLAN (GitHub Actions, her gece 04:00 TR)
  ingest → validate → features → train → export → track
                ↓ bozuksa DURUR             ↓
                                     web/data/*.json  →  commit

SİTE (GitHub Pages, sunucu yok)
  index.html + app.js  →  JSON'u okur, ekrana basar
```

## Model

Tek bir şey tahmin edilir: **her takımın o maçta atması beklenen gol sayısı (λ)**.
İki λ'dan Dixon-Coles düzeltmeli bir Poisson skor matrisi kurulur ve bütün
marketler aynı matristen okunur.

```
λ_ev = 1.62, λ_dep = 1.11
        ↓
   11×11 skor matrisi
        ↓
  i>j toplamı  → ev sahibi kazanır
  i+j>2.5      → 2.5 üst
  i>0 & j>0    → karşılıklı gol
  en büyük hücreler → en olası skorlar
```

Bunun ayrı ayrı eğitilmiş üç sınıflandırıcıya göre avantajı, tahminlerin
birbiriyle çelişememesi. Bağımsız modeller "ev sahibi kazanır" + "2.5 alt" +
"karşılıklı gol var" diyebilir; bu kombinasyon neredeyse imkânsızdır.

**Girdiler:** Elo gücü (sezon arası ortalamaya dönüşlü), son 5 ve 10 maçın gol
ve xG ortalamaları, ev/deplasman formu, dinlenme süresi, lig.

## Ölçüm

Walk-forward: her sezon, yalnızca kendisinden önce oynanmış maçlarla eğitilen
modelle tahmin edildi. 3504 maç:

| Market | Logloss | Baseline | Kazanç | İsabet | Baseline isabet |
|---|---|---|---|---|---|
| 1X2 | 0.9975 | 1.0753 | **+%7.2** | %51.8 | %43.0 |
| 2.5 Alt/Üst | 0.6871 | 0.6914 | +%0.6 | %55.5 | %53.2 |
| KG Var/Yok | 0.6897 | 0.6891 | −%0.1 | %54.0 | %54.6 |

Yalnızca 1X2'de gerçek bir avantaj var. Diğer iki market taban oranı söylemekten
daha iyi değil ve sitede bu açıkça yazıyor. Çıplak isabet oranı yanıltıcıdır:
"her maça üst de" demek %53 verir.

## Kurulum

```bash
pip install -r requirements.txt

python -m pipeline.ingest      # Understat'tan ham veri
python -m pipeline.validate    # bütünlük kontrolü (bloklayıcı)
python -m pipeline.features    # Elo + rolling feature'lar
python -m pipeline.train       # gol modeli
python -m pipeline.backtest    # walk-forward ölçüm → models/metrics.json
python -m pipeline.export      # web/data/*.json
python -m pipeline.track       # tahmin kaydı + sonuç eşleştirme

python -m pytest tests/ -q     # sızıntı ve takip testleri

cd web && python -m http.server 8000   # siteyi lokalde aç
```

## Yeni sezona geçiş

`pipeline/config.py` içinde iki satır:

```python
CURRENT_SEASON = "2027_2028"
SEASONS = [..., "2027_2028"]
```

Başka hiçbir yerde sezon bilgisi yok.

## Veri bütünlüğü

`pipeline/validate.py` her çalıştırmada şunları zorunlu kılar ve başarısız
olursa pipeline durur:

- lig başına doğru takım ve maç sayısı
- takım kimliği ↔ isim eşleşmesi 1:1
- kopya maç veya kopya fikstür yok
- oynanmış maçta skor var, oynanmamışta yok
- maç tarihleri sezon aralığında
- Understat saat dilimi hâlâ UTC (yaz/kış kick-off ayrımıyla doğrulanır)

Takım kimliği olarak Understat'ın sayısal `team.id`'si kullanılır; isim
eşleştirme kodu yoktur. `tests/test_features.py` içindeki sızıntı testi, bir
maçın feature'larını o maçın kendi sonucu ve sonraki bütün maçlar silinmiş
veriyle yeniden üretip birebir karşılaştırır.

## Dosya düzeni

```
pipeline/
  config.py     sezonlar, ligler, yollar — tek doğruluk kaynağı
  sources/      understat.py, sofascore.py (TSL)
  ingest.py     ham veri → data/raw/
  validate.py   bütünlük kontrolleri
  features.py   Elo + rolling; eğitim ve tahmin ortak kullanır
  model.py      gol modeli + skor matrisi + marketler
  train.py      üretim modelini kurar
  backtest.py   walk-forward ölçüm
  predict.py    yaklaşan maçlar
  export.py     web/data/*.json
  track.py      tahmin geçmişi (data/predictions.sqlite)
web/            statik site
```

Bilgi amaçlıdır, bahis tavsiyesi değildir.
