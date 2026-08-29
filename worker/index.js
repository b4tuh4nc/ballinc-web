/**
 * Ballinc — FotMob maç detayı proxy'si (Cloudflare Worker).
 *
 * Neden gerekli: FotMob tarayıcıya yalnızca maç listesi ucunda CORS izni
 * veriyor. Olay akışını ve istatistikleri taşıyan `matchDetails` ucu
 * tarayıcıdan doğrudan çağrılamıyor. Bu worker o çağrıyı sunucu tarafında
 * yapıp CORS başlığıyla geri veriyor.
 *
 * Bilerek DAR tutuldu — açık proxy'ye dönüşmemesi için:
 *   * Yalnızca sabit FotMob uçlarına gidiyor, hedef URL dışarıdan alınmıyor.
 *   * Bütün parametreler yalnızca rakamlardan oluşabiliyor.
 *   * Yalnızca izin verilen origin'lere CORS başlığı dönüyor.
 *   * Yanıt önbelleğe alınıyor; aynı maç için ardışık istekler FotMob'a
 *     ulaşmıyor. Bitmiş maçlar uzun süre önbellekte kalıyor (değişmiyorlar).
 *
 * Önbellek notu: Cloudflare'in Cache API'si `*.workers.dev` adreslerinde
 * çalışmıyor (sessizce hiçbir şey yapmıyor). Bu yüzden isolate ömrü boyunca
 * yaşayan basit bir bellek içi önbellek de var.
 */

const ALLOWED_ORIGINS = new Set([
  "https://ballinc.batuhanciftci.com",
  "https://b4tuh4nc.github.io",
]);

const DETAILS = "https://www.fotmob.com/api/data/matchDetails?matchId=";
const BY_DATE = "https://www.fotmob.com/api/data/matches?date=";

const LIVE_CACHE = 30;      // devam eden maç
const DONE_CACHE = 21600;   // bitmiş maç: bir daha değişmiyor

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Gösterilecek istatistikler ve Türkçe karşılıkları. Listede olmayan
// istatistik gösterilmiyor: FotMob 8 grup / ~40 satır veriyor, hepsini
// taşımanın anlamı yok.
const STAT_LABELS = {
  BallPossesion: "Topla oynama",
  expected_goals: "Beklenen gol (xG)",
  total_shots: "Toplam şut",
  ShotsOnTarget: "İsabetli şut",
  ShotsOffTarget: "İsabetsiz şut",
  big_chance: "Net fırsat",
  big_chance_missed_title: "Kaçan net fırsat",
  touches_opp_box: "Rakip ceza sahasında temas",
  accurate_passes: "İsabetli pas",
  corners: "Korner",
  fouls: "Faul",
  yellow_cards: "Sarı kart",
  red_cards: "Kırmızı kart",
  saves: "Kurtarış",
  offsides: "Ofsayt",
};

const memory = new Map();

function memoryGet(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl * 1000) {
    memory.delete(key);
    return null;
  }
  return hit.body;
}

function memorySet(key, body, ttl) {
  if (memory.size > 200) memory.delete(memory.keys().next().value);
  memory.set(key, { at: Date.now(), body, ttl });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function upstream(url) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
}

/** Bitmiş maçlarda FotMob maç kimliği elimizde olmuyor: site yalnızca takım
    kimliklerini ve tarihi biliyor. Gün listesinden kimliği buluyoruz. */
async function resolveMatchId(date, home, away) {
  const response = await upstream(BY_DATE + date);
  if (!response.ok) return null;
  const payload = await response.json();
  for (const league of payload.leagues ?? []) {
    for (const match of league.matches ?? []) {
      if (String(match.home?.id) === home && String(match.away?.id) === away) {
        return String(match.id);
      }
    }
  }
  return null;
}

/** Olay akışı. Skor alanı olayın ÖNCESİNİ gösterdiği için gol sonrası skor
    bir sonraki olaydan okunuyor; son golde maçın kendi skoruna düşülüyor. */
function buildTimeline(events, finalScore) {
  const scoreAfter = (index) => {
    for (let i = index + 1; i < events.length; i += 1) {
      const e = events[i];
      if (Number.isInteger(e.homeScore) && Number.isInteger(e.awayScore)) {
        return [e.homeScore, e.awayScore];
      }
    }
    return finalScore;
  };

  const out = [];
  events.forEach((e, index) => {
    const at = { m: e.time ?? null, add: e.overloadTime || 0 };
    const who = { home: !!e.isHome, name: e.nameStr ?? e.player?.name ?? "" };

    switch (e.type) {
      case "Goal":
        out.push({
          ...at, ...who, t: "gol",
          own: !!e.ownGoal,
          pen: /penalty/i.test(e.goalDescription ?? ""),
          assist: e.assistStr ?? null,
          score: scoreAfter(index),
        });
        break;
      case "Card":
        out.push({
          ...at, ...who, t: "kart",
          card: /yellowred/i.test(e.card ?? "") ? "ikinci"
            : /red/i.test(e.card ?? "") ? "kirmizi" : "sari",
        });
        break;
      case "Substitution":
        out.push({
          ...at, home: !!e.isHome, t: "degisiklik",
          in: e.swap?.[0]?.name ?? "",
          out: e.swap?.[1]?.name ?? "",
        });
        break;
      case "Half":
        out.push({
          m: e.time ?? null, t: "devre",
          label: e.halfStrShort ?? "",
          score: [e.homeScore ?? 0, e.awayScore ?? 0],
        });
        break;
      case "AddedTime":
        out.push({ m: e.time ?? null, t: "uzatma", mins: e.minutesAddedInput ?? null });
        break;
      case "VAR": {
        // Karar hem anahtar hem de FotMob'un kendi metniyle geçiyor: site
        // anahtarı Türkçeye çeviriyor, tanımadığı bir karar gelirse metne
        // düşüyor. Böylece yeni bir karar türü çıkınca bilgi kaybolmuyor.
        const decision = e.VAR?.decision ?? {};
        out.push({
          ...at, ...who, t: "var",
          pending: !!e.VAR?.pendingDecision,
          keys: decision.key ?? [],
          words: decision.value ?? [],
        });
        break;
      }
      default:
        break;   // Comment ve tanımadığımız tipler atlanıyor
    }
  });
  return out;
}

function buildStats(periods) {
  const groups = periods?.All?.stats ?? [];
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const stat of group.stats ?? []) {
      const label = STAT_LABELS[stat.key];
      if (!label || seen.has(stat.key)) continue;
      const [home, away] = stat.stats ?? [];
      if (home === null || home === undefined || away === null || away === undefined) continue;
      seen.add(stat.key);
      out.push({ key: stat.key, label, home: String(home), away: String(away),
                 bar: stat.type === "graph" });
    }
  }
  return out;
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") ?? "";
    const allowed = ALLOWED_ORIGINS.has(origin) || /^http:\/\/localhost:\d+$/.test(origin);
    if (!allowed) return new Response("origin izinli değil", { status: 403 });

    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return new Response("yalnızca GET", { status: 405, headers: cors });
    }

    const params = new URL(request.url).searchParams;
    let matchId = params.get("matchId") ?? "";
    const date = params.get("date") ?? "";
    const home = params.get("home") ?? "";
    const away = params.get("away") ?? "";

    const num = (v, max) => new RegExp(`^\\d{1,${max}}$`).test(v);

    if (!num(matchId, 12)) {
      // Maç kimliği yoksa tarih + takım kimlikleriyle çözülüyor.
      if (!(num(date, 8) && date.length === 8 && num(home, 10) && num(away, 10))) {
        return new Response("geçersiz parametre", { status: 400, headers: cors });
      }
      const key = `resolve:${date}:${home}:${away}`;
      matchId = memoryGet(key) ?? await resolveMatchId(date, home, away);
      if (!matchId) {
        return new Response("maç bulunamadı", { status: 404, headers: cors });
      }
      memorySet(key, matchId, DONE_CACHE);
    }

    const cached = memoryGet(`match:${matchId}`);
    if (cached) {
      return new Response(cached, {
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
      });
    }

    const cache = caches.default;
    const cacheKey = new Request(`https://ballinc-proxy/match/${matchId}`, request);
    const hit = await cache.match(cacheKey);
    if (hit) {
      const copy = new Response(hit.body, hit);
      Object.entries(cors).forEach(([k, v]) => copy.headers.set(k, v));
      return copy;
    }

    const response = await upstream(DETAILS + matchId);
    if (!response.ok) {
      return new Response(`kaynak hatası: ${response.status}`, { status: 502, headers: cors });
    }

    // Sadece gereken alanlar geçiriliyor: 300 KB'lık yanıtın tamamını
    // taşımanın anlamı yok.
    const payload = await response.json();
    const facts = payload?.content?.matchFacts ?? {};
    const events = facts.events?.events ?? [];
    const ongoing = !!facts.events?.ongoing;

    const goalEvents = events.filter((e) => e.type === "Goal");
    const finalScore = [
      goalEvents.filter((e) => (e.ownGoal ? !e.isHome : e.isHome)).length,
      goalEvents.filter((e) => (e.ownGoal ? e.isHome : !e.isHome)).length,
    ];

    const goals = goalEvents.map((e) => ({
      name: e.nameStr ?? e.player?.name ?? "",
      minute: e.timeStr ?? e.time,
      home: !!e.isHome,
      own: !!e.ownGoal,
      penalty: /penalty/i.test(e.goalDescription ?? ""),
      assist: e.assistStr ?? null,
    }));

    // "YellowRed" ikinci sarıdan gelen kırmızı; o da kırmızı sayılıyor.
    const redCards = events
      .filter((e) => e.type === "Card" && /red/i.test(e.card ?? ""))
      .map((e) => ({
        name: e.nameStr ?? e.player?.name ?? "",
        minute: e.timeStr ?? e.time,
        home: !!e.isHome,
        second: /yellowred/i.test(e.card ?? ""),
      }));

    const body = JSON.stringify({
      matchId,
      ongoing,
      goals,
      redCards,
      timeline: buildTimeline(events, finalScore),
      stats: buildStats(payload?.content?.stats?.Periods),
    });

    const ttl = ongoing ? LIVE_CACHE : DONE_CACHE;
    memorySet(`match:${matchId}`, body, ttl);

    const out = new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${ttl}`,
        ...cors,
      },
    });
    await cache.put(cacheKey, out.clone());
    return out;
  },
};
