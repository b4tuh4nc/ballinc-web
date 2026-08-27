# Ballinc

Beş Avrupa ligi ve Süper Lig için xG tabanlı maç tahminleri sunan statik web sitesi.

Sistem iki bağımsız parçadan oluşur. Bu ayrım kasıtlıdır: veri çekimi bozulduğunda
site etkilenmez.

```
ARKA PLAN (GitHub Actions, her gece 04:00 TR)
  ingest → validate → features → train → export → track
                ↓ bozuksa DURUR             ↓
                                     web/data/*.json  →  commit

  Kaynaklar: Understat (5 Avrupa ligi, xG'li) · FotMob (Süper Lig)

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
modelle tahmin edildi. 4217 maç:

| Market | Logloss | Baseline | Kazanç | İsabet | Baseline isabet |
|---|---|---|---|---|---|
| 1X2 | 0.9926 | 1.0743 | **+%7.6** | %52.1 | %43.4 |
| 2.5 Alt/Üst | 0.6858 | 0.6911 | +%0.8 | %54.9 | %53.3 |
| KG Var/Yok | 0.6897 | 0.6892 | −%0.1 | %54.2 | %54.5 |

Yalnızca 1X2'de gerçek bir avantaj var. Diğer iki market taban oranı söylemekten
daha iyi değil ve sitede bu açıkça yazıyor. Çıplak isabet oranı yanıltıcıdır:
"her maça üst de" demek %53 verir.

Lig bazında 1X2 kazancı:

| Lig | Maç | Kazanç | İsabet | Baseline |
|---|---|---|---|---|
| Serie A | 760 | +%8.9 | %52.2 | %39.3 |
| Süper Lig | 648 | +%8.8 | %52.8 | %45.5 |
| Bundesliga | 612 | +%8.3 | %52.1 | %41.2 |
| La Liga | 760 | +%7.3 | %52.4 | %46.7 |
| Ligue 1 | 612 | +%7.0 | %52.8 | %46.4 |
| Premier Lig | 760 | +%5.6 | %50.5 | %41.7 |

Süper Lig'de xG verisi olmamasına rağmen model burada Premier Lig'den daha iyi
çalışıyor — Elo ve gol formu yeterli sinyali taşıyor. Sitedeki not bu yüzden
"xG yok" der ama kalite iddiasında bulunmaz.

## Kurulum

```bash
pip install -r requirements.txt

python -m pipeline.ingest      # ham veri
python -m pipeline.crosswalk   # takım eşlemesi (nadiren; --lenient CI için)
python -m pipeline.rounds      # hafta numaraları
python -m pipeline.logos       # logolar (bir kez indirir)
python -m pipeline.validate    # bütünlük kontrolü (bloklayıcı)
python -m pipeline.features    # Elo + rolling feature'lar
python -m pipeline.train       # gol modeli
python -m pipeline.backtest    # walk-forward ölçüm → models/metrics.json
python -m pipeline.export      # web/data/*.json
python -m pipeline.track       # tahmin kaydı + sonuç eşleştirme

python -m pytest tests/ -q     # sızıntı ve takip testleri

cd web && python -m http.server 8000   # siteyi lokalde aç
```

## Veri kaynakları

| Lig | Birincil kaynak | xG |
|---|---|---|
| Premier Lig, La Liga, Serie A, Bundesliga, Ligue 1 | Understat | ✓ |
| Süper Lig | FotMob | ✗ |

FotMob ayrıca **her ligde** ikincil kaynak: takım logoları ve hafta numaraları
oradan geliyor, ayrıca Understat bir sezonun fikstürünü henüz yayınlamamışsa
(Bundesliga 26/27 böyleydi) fikstür geçici olarak FotMob'dan alınıyor.
Oynanmamış maçta xG zaten olmadığı için bu bir kayıp değil.

İkisi de düz `requests` ile erişilebiliyor; tarayıcı otomasyonu gerekmiyor.
Bir kaynak geçici olarak erişilemezse diskteki mevcut veri korunur ve akış
durmaz — log'da `tazelenemedi, mevcut veri korundu` satırı görünür.

Takım ve maç kimlikleri kaynaktan bağımsız: `pipeline/crosswalk.py` Understat
ve FotMob takımlarını 1:1 eşliyor, `ingest.canonicalise` yedek kaynaktan gelen
takımları kanonik kimliğe çeviriyor ve maç kimliği `(lig, sezon, ev, deplasman)`
üçlüsünden türetiliyor. Böylece kaynak değişince bir takımın geçmişi kopmuyor
ve kaydedilmiş tahmin sonucuyla eşleşmeye devam ediyor.

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

- yapısal tutarlılık: maç sayısı == takım × (takım − 1), her takım eşit
  sayıda ev maçı. Takım sayısı **veriden türetilir**, config'e yazılmaz —
  sabit bir sayı yanlış olduğunda hem veriyi kırpar hem de doğrulamayı
  kandırır (Süper Lig 2023/24'te 20, 2024/25'te 19, sonra 18 takımlıydı)
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
  sources/      understat.py, fotmob.py
  crosswalk.py  Understat <-> FotMob takım eşlemesi (logo + hafta için)
  rounds.py     hafta numaraları
  logos.py      takım ve lig logoları -> web/assets/
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
