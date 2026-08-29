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

**Girdiler:** Elo gücü (sezon arası ortalamaya dönüşlü), takım başına xG
tabanlı hücum ve savunma gücü, son 5 ve 10 maçın gol ve xG ortalamaları,
ev/deplasman formu, dinlenme süresi, lig.

Model **27.754 maçla** eğitiliyor (2014/15'ten bugüne, 6 lig). Veri miktarı
ölçülebilir fark yaratıyor: 3 sezondan 12 sezona çıkmak kazancı %7.2'den
%8.1'e, xG hücum/savunma reytingi de %8.5'e taşıdı. Eski maçların ağırlığını
azaltmayı da denedim — hiçbir yarı-ömür değeri iyileştirmedi, yani 2015'teki
maçlar hâlâ değerli.

## Ölçüm

Walk-forward: her sezon, yalnızca kendisinden önce oynanmış maçlarla eğitilen
modelle tahmin edildi. 4219 maç:

| Market | Logloss | Baseline | Kazanç | İsabet | Baseline isabet |
|---|---|---|---|---|---|
| 1X2 | 0.9839 | 1.0740 | **+%8.4** | %52.8 | %43.4 |
| 2.5 Alt/Üst | 0.6788 | 0.6911 | +%1.8 | %56.1 | %53.3 |
| KG Var/Yok | 0.6868 | 0.6894 | +%0.4 | %54.3 | %54.5 |

Yalnızca 1X2'de güvenilir bir avantaj var. Diğer iki market %2'lik eşiğin
altında kalıyor ve sitede "taban orandan farkı yok" uyarısıyla gösteriliyor. Çıplak isabet oranı yanıltıcıdır:
"her maça üst de" demek %53 verir.

Lig bazında 1X2 kazancı:

| Lig | Maç | Kazanç | İsabet | Baseline |
|---|---|---|---|---|
| Serie A | 760 | +%9.9 | %52.4 | %39.3 |
| Bundesliga | 612 | +%9.0 | %52.3 | %41.2 |
| La Liga | 760 | +%8.5 | %53.9 | %46.7 |
| Süper Lig | 648 | +%8.1 | %53.7 | %45.5 |
| Ligue 1 | 612 | +%7.7 | %54.6 | %46.4 |
| Premier Lig | 760 | +%7.1 | %50.5 | %41.7 |

Süper Lig'de xG verisi olmamasına rağmen model burada Premier Lig'den daha iyi
çalışıyor — Elo ve gol formu yeterli sinyali taşıyor. Sitedeki not bu yüzden
"xG yok" der ama kalite iddiasında bulunmaz.

## Kurulum

Biten sezonlar `data/archive/` altında repoda duruyor ve yeniden çekilmiyor;
yalnızca güncel iki sezon her koşuda tazeleniyor.

```bash
pip install -r requirements.txt

python -m pipeline.ingest      # ham veri (arşiv atlanır)
python -m pipeline.crosswalk   # takım eşlemesi (nadiren; --lenient CI için)
python -m pipeline.rounds      # hafta numaraları
python -m pipeline.logos       # logolar (bir kez indirir)
python -m pipeline.validate    # bütünlük kontrolü (bloklayıcı)
python -m pipeline.features    # Elo + rolling feature'lar
python -m pipeline.train       # gol modeli
python -m pipeline.backtest    # walk-forward ölçüm → models/metrics.json
python -m pipeline.market      # bahis oranları (ODDS_API_KEY gerekir)
python -m pipeline.export      # web/data/*.json
python -m pipeline.track       # tahmin kaydı + sonuç eşleştirme

python -m pytest tests/ -q     # sızıntı ve takip testleri

cd web && python -m http.server 8000   # siteyi lokalde aç
```

## web/data kimin?

`web/data/*.json` **CI tarafından üretilir**; lokalden commit edilmemeli.
Lokal `export` ne bulursa onu yayınlar: ham veri eskiyse, o sırada bitmiş bir
maç yaklaşanlardan düşer (kick-off 3.5 saati geçmiş) ama sonuçlara da girmez
(ham veride skoru yok) ve siteden tamamen kaybolur. `export` bu maçları sayıp
adlarıyla uyarıyor, ama en güvenlisi işi CI'ya bırakmak. Lokalde test için
çalıştırdıysan `git checkout -- web/data` ile geri al.

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
ARCHIVE_SEASONS = [f"{y}_{y + 1}" for y in range(2014, 2026)]  # biten sezon eklenir
LIVE_SEASONS = ["2026_2027", "2027_2028"]
```

Başka hiçbir yerde sezon bilgisi yok. Biten bir sezonu arşive almak, o sezonun
bir daha çekilmemesi ve dosyasının repoda kalması demek.

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
  ingest.py     ham veri → data/raw/ (arşiv: data/archive/)
  validate.py   bütünlük kontrolleri
  features.py   Elo + rolling; eğitim ve tahmin ortak kullanır
  model.py      gol modeli + skor matrisi + marketler
  train.py      üretim modelini kurar
  backtest.py   walk-forward ölçüm
  predict.py    yaklaşan maçlar
  export.py     web/data/*.json
  market.py     bahis oranları -> data/market_odds.json
  track.py      tahmin geçmişi (data/predictions.sqlite)
web/            statik site
```

## Canlı skorlar

Devam eden maçların skoru ve dakikası, tarayıcıdan doğrudan FotMob'dan
çekiliyor (60 saniyede bir, sekme arka plandayken durur). Ek sunucu, proxy ya
da dakikalık deploy gerekmiyor: FotMob `Origin` başlığı gelen isteklere CORS
izni veriyor, dolayısıyla statik site kendi başına canlı veri alabiliyor.

Maçlar canlı veriyle **isimle değil kimlikle** eşleşiyor; `export` her maça
FotMob takım kimliklerini yazıyor. Çağrı başarısız olursa hiçbir şey bozulmaz,
site canlı veri olmadan tam çalışmaya devam eder.

`predict.upcoming` penceresi 3.5 saat geriye de açık: aksi halde bir maç
başlar başlamaz fikstürden düşüyor ve canlı skoru gösterilemiyordu.

### Maç akışı, golcüler ve istatistikler

FotMob tarayıcıya yalnızca maç listesi ucunda CORS izni veriyor; olay akışını
ve istatistikleri taşıyan `matchDetails` ucu kapalı. `worker/` altındaki
Cloudflare Worker o çağrıyı sunucu tarafında yapıp yalnızca gereken alanları
döndürüyor: goller, kartlar, değişiklikler, devre bantları ve 15 istatistik.

Bitmiş maçta FotMob maç kimliği elimizde olmuyor — site yalnızca takım
kimliklerini ve tarihi biliyor. Worker maçı `date` + `home` + `away` ile de
bulabiliyor. Bitmiş maç yanıtı 6 saat önbellekte kalıyor, devam eden maç 30
saniye.

**Worker değişirse yeniden deploy edilmesi gerekiyor**; edilmezse site akışı
sessizce göstermez, geri kalanı çalışmaya devam eder.

Kurulumu `worker/README.md` içinde. Deploy sonrası adresi
`pipeline/config.py` → `GOAL_PROXY_URL` alanına yazmak yeterli; adres boşken
site golcü göstermeye hiç çalışmıyor.

## Model ve bahis piyasası

Maç sayfalarında model olasılıkları, bahis piyasasının fiyatladığı olasılıkların
yanında gösteriliyor. Piyasa sütunu ~25 bahisçinin oranlarından kâr marjı
(overround) temizlenip medyan alınarak hesaplanıyor; EV sütunu
`p_model × (oran − 1) − (1 − p_model)`.

Bu bir kâr vaadi değil. Baseline'ı geçmek kolaydır; asıl zor olan bahis
piyasasını geçmektir, çünkü oranlar sakatlık ve kadro bilgisini de içerir.
Her tahmin, piyasa olasılığıyla birlikte **maç oynanmadan önce** kaydediliyor;
maçlar sonuçlandıkça ikisi aynı ölçüyle (logloss) kıyaslanıyor ve sonuç
"Model ne kadar iyi?" sayfasında yayınlanıyor — model geride kalırsa da öyle
yazacak.

API anahtarı yalnızca `ODDS_API_KEY` ortam değişkeninden okunuyor, hiçbir
dosyaya yazılmıyor (CI'da GitHub secret olarak duruyor).

Bilgi amaçlıdır, bahis tavsiyesi değildir.
