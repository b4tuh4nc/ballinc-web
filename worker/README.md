# FotMob maç detayı proxy'si

FotMob tarayıcıya yalnızca maç listesi ucunda CORS izni veriyor; olay akışını
ve istatistikleri taşıyan `matchDetails` ucu kapalı. Bu worker o çağrıyı
sunucu tarafında yapıp CORS başlığıyla geri veriyor.

Açık proxy değil: hedef URL sabit, bütün parametreler yalnızca rakam
olabiliyor, yalnızca izinli origin'lere yanıt veriyor ve önbellekliyor.
Ayrıca 300 KB'lık yanıtın tamamını değil, yalnızca gereken alanları
döndürüyor.

Dönen alanlar:

| Alan | Ne |
|---|---|
| `goals`, `redCards` | maç satırındaki golcü ve kart rozetleri |
| `timeline` | dakika dakika olay akışı (gol, kart, değişiklik, devre, VAR) |
| `stats` | 15 istatistik, Türkçe etiketli |
| `ongoing` | maç devam ediyor mu |

Maç iki şekilde bulunabiliyor: `?matchId=…` (canlı maçlarda kimlik elimizde)
ya da `?date=YYYYAAGG&home=<fm>&away=<fm>` — bitmiş maçlarda FotMob maç
kimliği elimizde olmadığı için gerekiyor. Bitmiş maç yanıtı 6 saat, devam
eden maç 30 saniye önbellekte kalıyor.

**Maliyet:** ücretsiz katman günde 100.000 istek veriyor, kredi kartı
istemiyor. Bu projenin kullanımı günde birkaç yüz istek.

**Önbellek:** Cloudflare'in Cache API'si `*.workers.dev` adreslerinde
çalışmıyor. Bu yüzden worker'da bellek içi bir yedek önbellek de var.
Kendi alan adına bir route bağlarsan Cache API de devreye girer, ama
gerekli değil.

## Kurulum

Panelden (en kolay):

1. dash.cloudflare.com → Workers & Pages → Create → Start with Hello World
2. İsim: `ballinc-proxy`, Deploy
3. Edit code → `index.js` içeriğini yapıştır → Deploy

## Güncelleme

`worker/index.js` her değiştiğinde yeniden deploy edilmesi gerekiyor; site
bunu sessizce tolere eder (akış ve istatistikler görünmez, geri kalanı
çalışır) ama kimse hata görmediği için fark edilmesi zordur.

1. dash.cloudflare.com → Workers & Pages → `ballinc-proxy`
2. Edit code (ya da "Quick edit")
3. Editördeki her şeyi sil, `worker/index.js` dosyasının **tamamını**
   yapıştır
4. Deploy

Doğrulama — yanıtta `timeline` ve `stats` alanları görünmeli:

```bash
curl -s -H "Origin: https://ballinc.batuhanciftci.com"   "https://ballinc-proxy.<hesabın>.workers.dev/?matchId=4506574" | head -c 300
```

Tarayıcıda doğrudan açarsan `origin izinli değil` yazar; bu normaldir,
worker yalnızca sitenin adresinden gelen isteklere yanıt verir.

Ya da CLI ile:

```bash
npm install -g wrangler
wrangler login
cd worker && wrangler deploy
```

Deploy sonrası adres `https://ballinc-proxy.<hesabın>.workers.dev` olur.
Bu adresi `pipeline/config.py` içindeki `GOAL_PROXY_URL` alanına yaz ve
pipeline'ı çalıştır; site golcüleri göstermeye başlar.

## Yeni bir alan adı eklersen

`index.js` içindeki `ALLOWED_ORIGINS` listesine ekle ve yeniden deploy et.
