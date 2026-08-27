# FotMob maç detayı proxy'si

FotMob tarayıcıya yalnızca maç listesi ucunda CORS izni veriyor; golcü
bilgisini taşıyan `matchDetails` ucu kapalı. Bu worker o çağrıyı sunucu
tarafında yapıp CORS başlığıyla geri veriyor.

Açık proxy değil: hedef URL sabit, `matchId` yalnızca rakam olabiliyor,
yalnızca izinli origin'lere yanıt veriyor ve 30 saniye önbellekliyor.
Ayrıca 145 KB'lık yanıtın tamamını değil, yalnızca gol olaylarını döndürüyor.

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
