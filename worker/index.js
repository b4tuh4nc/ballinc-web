/**
 * Ballinc — FotMob maç detayı proxy'si (Cloudflare Worker).
 *
 * Neden gerekli: FotMob tarayıcıya yalnızca maç listesi ucunda CORS izni
 * veriyor. Golcü bilgisini taşıyan `matchDetails` ucu tarayıcıdan doğrudan
 * çağrılamıyor. Bu worker o çağrıyı sunucu tarafında yapıp CORS başlığıyla
 * geri veriyor.
 *
 * Bilerek DAR tutuldu — açık proxy'ye dönüşmemesi için:
 *   * Yalnızca sabit FotMob ucuna gidiyor, hedef URL dışarıdan alınmıyor.
 *   * `matchId` yalnızca rakamlardan oluşabiliyor.
 *   * Yalnızca izin verilen origin'lere CORS başlığı dönüyor.
 *   * Yanıt 30 saniye önbelleğe alınıyor; aynı maç için gelen ardışık
 *     istekler FotMob'a ulaşmıyor.
 */

const ALLOWED_ORIGINS = new Set([
  "https://ballinc.batuhanciftci.com",
  "https://b4tuh4nc.github.io",
]);

const UPSTREAM = "https://www.fotmob.com/api/data/matchDetails?matchId=";
const CACHE_SECONDS = 30;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") ?? "";
    // Yerel geliştirme için localhost'un her portuna izin veriliyor.
    const allowed = ALLOWED_ORIGINS.has(origin) || /^http:\/\/localhost:\d+$/.test(origin);
    if (!allowed) {
      return new Response("origin izinli değil", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return new Response("yalnızca GET", { status: 405, headers: corsHeaders(origin) });
    }

    const matchId = new URL(request.url).searchParams.get("matchId") ?? "";
    if (!/^\d{1,12}$/.test(matchId)) {
      return new Response("geçersiz matchId", { status: 400, headers: corsHeaders(origin) });
    }

    const cache = caches.default;
    const cacheKey = new Request(`https://ballinc-proxy/match/${matchId}`, request);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => hit.headers.set(k, v));
      return hit;
    }

    const upstream = await fetch(UPSTREAM + matchId, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!upstream.ok) {
      return new Response(`kaynak hatası: ${upstream.status}`, {
        status: 502,
        headers: corsHeaders(origin),
      });
    }

    // Sadece gereken alanlar geçiriliyor: 145 KB'lık yanıtın tamamını
    // taşımanın anlamı yok, gol olaylarını çıkarıp küçük bir gövde dönüyoruz.
    const payload = await upstream.json();
    const events = payload?.content?.matchFacts?.events?.events ?? [];
    const goals = events
      .filter((e) => e.type === "Goal")
      .map((e) => ({
        name: e.nameStr ?? e.player?.name ?? "",
        minute: e.timeStr ?? e.time,
        home: !!e.isHome,
        own: !!e.ownGoal,
        penalty: /penalty/i.test(e.goalDescription ?? ""),
        assist: e.assistStr ?? null,
      }));

    const response = new Response(JSON.stringify({ matchId, goals }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
        ...corsHeaders(origin),
      },
    });
    await cache.put(cacheKey, response.clone());
    return response;
  },
};
