/* Ballinc — statik ön yüz.
   Sunucu yok: pipeline'ın ürettiği data/*.json dosyalarını okuyup render eder.
   Yönlendirme hash tabanlı, böylece GitHub Pages'te ek ayar gerekmiyor. */

const TZ = "Europe/Istanbul";
const cache = new Map();
const DOW = ["PAZ", "PTS", "SAL", "ÇAR", "PER", "CUM", "CTS"];
const STRIP_DAYS = 7;

// Emoji takvim, yanındaki ok düğmeleriyle uyumsuz duruyordu: kendi rengi var,
// platformdan platforma değişiyor ve küçük kalıyordu. Çizgi ikon currentColor
// kullanıyor, dolayısıyla temayla ve hover durumuyla birlikte değişiyor.
const CAL_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none"
  stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
  <rect x="3" y="5" width="18" height="16" rx="2.5"/>
  <path d="M3 10h18M8 3v4M16 3v4"/></svg>`;

const SIDE_MARKETS = [
  { key: "over_2_5", title: "2.5 Alt / Üst",  labels: ["2.5 Alt", "2.5 Üst"], fills: ["draw", "yes"] },
  { key: "btts",     title: "Karşılıklı Gol", labels: ["Yok", "Var"],         fills: ["draw", "yes"] },
];

const COMPARE_ROWS = [
  { label: "Elo", pick: (t) => t.elo },
  { label: "Attığı gol", pick: (t) => t.stats?.gf },
  { label: "Yediği gol", pick: (t) => t.stats?.ga },
  { label: "Ürettiği xG", pick: (t) => t.stats?.xgf },
  { label: "Yediği xG", pick: (t) => t.stats?.xga },
  { label: "Puan ort.", pick: (t) => t.stats?.pts },
];

// ─── Yardımcılar ───────────────────────────────────────────────────────────

const el = document.getElementById.bind(document);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (p) => Math.round(p * 100);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

async function getJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const promise = fetch(`data/${path}`, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  });
  cache.set(path, promise);
  return promise;
}

const timeIn = (iso) => new Date(iso).toLocaleTimeString("tr-TR", {
  timeZone: TZ, hour: "2-digit", minute: "2-digit",
});

const dayKey = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: TZ });
const todayKey = () => new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

/** Gün anahtarını (YYYY-MM-DD) saat diliminden bağımsız çözer.
    Öğlen UTC alınıyor ki hiçbir zaman diliminde gün kaymasın. */
const keyDate = (key) => new Date(`${key}T12:00:00Z`);

function dayLabel(iso) {
  const key = dayKey(iso);
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString("sv-SE", { timeZone: TZ });
  if (key === todayKey()) return "Bugün";
  if (key === tomorrow) return "Yarın";
  return new Date(iso).toLocaleDateString("tr-TR", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long",
  });
}

function shiftKey(key, days) {
  const d = keyDate(key);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const FALLBACK_CREST =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E" +
  "%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='%23999' stroke-width='1.5'/%3E%3C/svg%3E";

const crest = (id, extra = "") =>
  `<img class="crest ${extra}" src="assets/teams/${encodeURIComponent(id)}.png" alt=""
        loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK_CREST}'">`;

const leagueLogo = (code) => `
  <img class="logo-light" src="assets/leagues/${encodeURIComponent(code)}.png" alt="" loading="lazy"
       onerror="this.style.display='none'">
  <img class="logo-dark" src="assets/leagues/${encodeURIComponent(code)}-dark.png" alt="" loading="lazy"
       onerror="this.style.display='none'">`;

function reliability(metrics, key) {
  const m = metrics?.[key];
  return m ? { reliable: m.reliable, skill: m.skill, n: m.n } : null;
}

// ─── Maç satırı ────────────────────────────────────────────────────────────

/* Beraberlik hiçbir maçta en olası sonuç çıkmıyor: iki gol beklentisinden
   kurulan Poisson matrisinde beraberlik olasılığı %33'ü aşamıyor. Bu yüzden
   X kutusu hiç vurgulanmıyordu ve beraberliğe açık maçlar diğerlerinden
   ayırt edilemiyordu.

   Eşik ölçümle seçildi: beraberlik olasılığı %27'yi geçen maçlarda (maçların
   dörtte biri) gerçek beraberlik oranı %28.7 — taban %25.2'nin belirgin
   üstünde. Yani vurgu boş bir uyarı değil. */
const DRAW_ALERT = 0.27;

function oddsCells(match) {
  const p = match.markets.result;
  const best = p.indexOf(Math.max(...p));
  const labels = ["1", "X", "2"];
  const drawish = p[1] >= DRAW_ALERT;
  return `<div class="odds">${p.map((v, i) => `
    <div class="odds-cell${i === best ? " best" : ""}${i === 1 && drawish ? " drawish" : ""}"${
      i === 1 && drawish ? ` title="Beraberliğe açık maç: bu olasılıktaki maçların yaklaşık %29 kadarı berabere bitiyor"` : ""}>
      <span>${labels[i]}</span><b>%${pct(v)}</b>
    </div>`).join("")}</div>`;
}

function extraChips(match) {
  const ou = match.markets.over_2_5, bt = match.markets.btts;
  if (!ou || !bt) return "";
  const over = ou[1] >= ou[0], yes = bt[1] >= bt[0];
  // Buraya "BERABERLİĞE AÇIK" diye ayrı bir çip konmuştu ama satırdaki
  // diğer çipleri kaydırıp listeyi hizasız bırakıyordu. Sarı X kutusu
  // uyarıyı zaten veriyor.
  return `<div class="extra">
    <span class="extra-chip">2.5 ${over ? "ÜST" : "ALT"} <b>%${pct(over ? ou[1] : ou[0])}</b></span>
    <span class="extra-chip">KG ${yes ? "VAR" : "YOK"} <b>%${pct(yes ? bt[1] : bt[0])}</b></span>
  </div>`;
}

function matchRow(match, index = 0) {
  const tbd = match.time_confirmed === false ? '<span class="tbd">saat?</span>' : "";
  const live = liveKey(match);
  return `
    <a class="match" style="--i:${index}"${live ? ` data-live="${live}"` : ""}
       data-fmday="${fotmobDay(match.kickoff)}"
       href="#/mac/${encodeURIComponent(match.id)}">
      <div class="match-time"><span class="clock">${timeIn(match.kickoff)}</span>${tbd}</div>
      <div class="match-teams">
        <div class="team-line">${crest(match.home.id)}<span class="team-name" data-team="${esc(match.home.id)}">${esc(match.home.name)}</span><span class="cards-h"></span><span class="team-score live-h"></span></div>
        <div class="team-line">${crest(match.away.id)}<span class="team-name" data-team="${esc(match.away.id)}">${esc(match.away.name)}</span><span class="cards-a"></span><span class="team-score live-a"></span></div>
      </div>
      <div class="match-markets">${oddsCells(match)}${extraChips(match)}</div>
      <div class="chev" aria-hidden="true">›</div>
    </a>`;
}

const PICK_LABEL = ["1", "X", "2"];

/** Oynanmış maçta modelin maç öncesi ne dediği ve tutup tutmadığı. */
function forecastChip(result) {
  const f = result.forecast;
  if (!f) return "";
  const cls = f.hit ? "hit" : "miss";
  return `<span class="pred-chip ${cls}" title="Model maç öncesi bu sonucu bekliyordu">
    <span class="mark">${f.hit ? "✓" : "✗"}</span>
    ${PICK_LABEL[f.pick]} <b>%${pct(f.probs[f.pick])}</b></span>`;
}

/** `perspective` verilirse (takım sayfası) sonuç o takım açısından
    G/B/M olarak işaretleniyor. Sadece skora bakıp kimin kazandığını çıkarmak,
    takımın kâh ev kâh deplasman olduğu bir listede yorucu. */
function resultRow(result, index = 0, perspective = null, done = false) {
  const [hg, ag] = result.score;
  const mine = perspective === result.home.id ? [hg, ag]
    : perspective === result.away.id ? [ag, hg] : null;
  const outcome = !mine ? "" : mine[0] > mine[1] ? "G" : mine[0] === mine[1] ? "B" : "M";
  const label = { G: "Galibiyet", B: "Beraberlik", M: "Mağlubiyet" }[outcome] ?? "";
  return `
    <a class="match${done ? " is-done" : ""}"${outcome ? ` data-outcome="${outcome}"` : ""}
       style="--i:${index}" href="#/mac/${encodeURIComponent(result.id)}">
      <div class="match-time">${done
        // Gün listesinde oynanmamış maçlarla yan yana duruyorlar; başlama
        // saati yerine durumu yazmak ayrımı netleştiriyor. Canlı veriyle
        // güncellenen satırlar da aynı sözcüğü kullanıyor.
        ? `<span class="clock">BİTTİ</span>`
        : timeIn(result.kickoff)}</div>
      <div class="match-teams">
        <div class="team-line${hg < ag ? " dim" : ""}">
          ${crest(result.home.id)}<span class="team-name" data-team="${esc(result.home.id)}">${esc(result.home.name)}</span>
          <span class="team-score">${hg}</span>
        </div>
        <div class="team-line${ag < hg ? " dim" : ""}">
          ${crest(result.away.id)}<span class="team-name" data-team="${esc(result.away.id)}">${esc(result.away.name)}</span>
          <span class="team-score">${ag}</span>
        </div>
      </div>
      <div class="match-markets">
        ${outcome ? `<span class="pill ${outcome}" title="${label}">${outcome}</span>` : ""}
        ${forecastChip(result)}
        ${result.xg ? `<span class="extra-chip">xG <b>${result.xg[0]} - ${result.xg[1]}</b></span>` : ""}
      </div>
      <div class="chev" aria-hidden="true">›</div>
    </a>`;
}

function groupByDay(matches) {
  const groups = new Map();
  for (const m of matches) {
    const key = dayKey(m.kickoff);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/* Maç, kick-off'tan 3.5 saat sonra tahmin listesinden düşüp sonuçlara
   geçiyor. Gün listeleri yalnızca tahmin listesini okuduğu için o maçlar
   günün listesinden TAMAMEN kayboluyordu — bugün oynanmış bir maçı görmek
   için lig sayfasının Sonuçlar sekmesine gitmek gerekiyordu. Skor zaten
   elimizde; günün listesinde skoruyla duruyorlar. */

/** Tahminli maç mı, oynanmış maç mı — ayrım skorun varlığından. */
const dayRow = (m, i) => (m.score ? resultRow(m, i, null, true) : matchRow(m, i));

/** Verilen günlerde oynanmış maçlar; gün listesine karıştırılmak üzere.

    İki kaynak birleşiyor: statik sonuçlar ve canlı veriden tamamlananlar
    (pipeline üç saatte bir çalıştığı için arada biten maçlar henüz statikte
    yok). Böylece o gün biten HER maç aynı biçimde, skoruyla çiziliyor —
    bitmiş bir maçın kimi satırda tahmin kutuları kimi satırda skor
    göstermesi kafa karıştırıyordu.

    Sonuçlarda lig kodu yok, lig dosyasının içinde zaten belli; gün listesi
    maçları lig lig grupladığı için burada ekleniyor. */
function playedOn(data, days) {
  const onDay = (r) => days.has(dayKey(r.kickoff));
  const fresh = freshResults(data).filter(onDay);
  const known = new Set(fresh.map((r) => r.id));
  const stored = (data.results ?? []).filter((r) => onDay(r) && !known.has(r.id));
  return [...fresh, ...stored].map((r) => ({ ...r, league: data.league }));
}

function matchListHTML(matches, played = []) {
  const done = new Set(played.map((r) => r.id));
  const all = [...matches.filter((m) => !done.has(m.id)), ...played]
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  if (!all.length) return `<div class="empty">Bu pencerede oynanacak maç yok.</div>`;
  return groupByDay(all).map(([, list]) => `
    <div class="date-head">${esc(dayLabel(list[0].kickoff))}</div>
    <div class="match-list">${list.map(dayRow).join("")}</div>
  `).join("");
}

// ─── Tarih şeridi ──────────────────────────────────────────────────────────

/** Maçları güne göre filtrelemek için kaydırılabilir gün seçici.
    Maçı olmayan günler devre dışı gösteriliyor — kullanıcı boş bir güne
    tıklayıp "site bozuk" sanmasın. */
function dateStripHTML(dates, selected, start, counts) {
  const window7 = dates.slice(start, start + STRIP_DAYS);
  const buttons = window7.map((key) => {
    const d = keyDate(key);
    const n = counts.get(key) ?? 0;
    return `
      <button class="day-btn" type="button" data-day="${key}"
              aria-pressed="${key === selected}" ${n ? "" : "disabled"}>
        <span class="dow">${DOW[d.getUTCDay()]}</span>
        <span class="dnum">${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}</span>
        ${n ? '<span class="dot"></span>' : ""}
      </button>`;
  }).join("");

  const canPrev = start > 0;
  const canNext = start + STRIP_DAYS < dates.length;
  return `
    <div class="datestrip">
      <button class="strip-nav" type="button" data-strip="-1" ${canPrev ? "" : "disabled"}
              aria-label="Önceki günler">‹</button>
      <div class="strip-track">${buttons}</div>
      <button class="strip-nav" type="button" data-strip="1" ${canNext ? "" : "disabled"}
              aria-label="Sonraki günler">›</button>
      <span class="cal-wrap">
        <button class="strip-nav cal-btn" type="button" data-cal="toggle"
                aria-expanded="${state.calOpen}" aria-label="Takvimden tarih seç">${CAL_ICON}</button>
        ${state.calOpen ? calendarHTML(dates, selected, counts) : ""}
      </span>
    </div>`;
}

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
                "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const CAL_DOW = ["Pt", "Sa", "Ça", "Pe", "Cu", "Ct", "Pa"];

/** Ay takvimi. Maçı olan günler noktalı ve tıklanabilir, diğerleri devre dışı. */
function calendarInner(dates, selected, counts) {
  const first = dates[0], last = dates[dates.length - 1];
  const month = state.calMonth ?? selected.slice(0, 7);
  const [year, mon] = month.split("-").map(Number);

  const firstOfMonth = new Date(Date.UTC(year, mon - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  // Pazartesi haftanın ilk günü: getUTCDay 0=Pazar, bunu 6'ya kaydırıyoruz.
  const lead = (firstOfMonth.getUTCDay() + 6) % 7;

  const cells = Array.from({ length: lead }, () => '<span class="cal-empty"></span>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const n = counts.get(key) ?? 0;
    const classes = ["cal-day"];
    if (key === todayKey()) classes.push("today");
    cells.push(`
      <button class="${classes.join(" ")}" type="button" data-day="${key}"
              aria-pressed="${key === selected}" ${n ? "" : "disabled"}>
        ${day}${n ? '<span class="cal-dot"></span>' : ""}
      </button>`);
  }

  const prevMonth = mon === 1 ? `${year - 1}-12` : `${year}-${String(mon - 1).padStart(2, "0")}`;
  const nextMonth = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
  const canPrev = prevMonth >= first.slice(0, 7);
  const canNext = nextMonth <= last.slice(0, 7);
  const todayUsable = counts.has(todayKey());

  return `
      <div class="cal-head">
        <button class="cal-nav" type="button" data-calmonth="${prevMonth}"
                ${canPrev ? "" : "disabled"} aria-label="Önceki ay">‹</button>
        <strong>${MONTHS[mon - 1]} ${year}</strong>
        <button class="cal-nav" type="button" data-calmonth="${nextMonth}"
                ${canNext ? "" : "disabled"} aria-label="Sonraki ay">›</button>
      </div>
      <div class="cal-grid cal-dow">${CAL_DOW.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cal-grid">${cells.join("")}</div>
      <div class="cal-foot">
        <button class="cal-today-btn" type="button" data-day="${todayKey()}"
                ${todayUsable ? "" : "disabled"}>Bugün</button>
      </div>`;
}

// Bulanık katman takvimle AYNI yığınlama bağlamında olmalı. Kök seviyeye
// koyduğumda .datestrip'in kendi bağlamı yüzünden takvimin z-index'i o
// katmanın altında kalıyor ve takvimin kendisi de bulanıklaşıyordu.
const calendarHTML = (dates, selected, counts) =>
  `<div class="cal-scrim" aria-hidden="true"></div>
   <div class="cal" role="dialog" aria-label="Tarih seç">
     ${calendarInner(dates, selected, counts)}
   </div>`;

// ─── Görünümler ────────────────────────────────────────────────────────────

async function viewHome() {
  const meta = await getJSON("meta.json");
  const hidden = hiddenLeagues();
  // Veri yalnızca maçı olan yarışmalar için yükleniyor, ama FİLTREDE hepsi
  // görünüyor: Avrupa Ligi ve Konferans Ligi henüz başlamadığı için listeden
  // düşüyorlardı ve kupalar grubu eksik görünüyordu.
  const active = meta.leagues.filter((l) => l.upcoming > 0);
  // Bugün oynanmış maçlar da günün listesinde kalsın; tahmin listesinden
  // düştükleri için kayboluyorlardı.
  const days = new Set([todayKey()]);
  const all = [];
  let predictions = 0;
  for (const league of active) {
    if (hidden.has(league.code)) continue;
    const data = await getJSON(`${league.code}.json`);
    predictions += data.matches.length;
    const played = playedOn(data, days);
    const done = new Set(played.map((r) => r.id));
    all.push(...data.matches.filter((m) => !done.has(m.id)));
    all.push(...played);
  }
  noteLiveDays(all);
  all.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const shown = meta.leagues.length
    - meta.leagues.filter((l) => hidden.has(l.code)).length;

  const idle = meta.leagues.filter((l) => l.upcoming === 0);
  const idleNote = idle.length ? `
    <p class="note">${idle.map((l) => esc(l.name)).join(", ")} için bu sezon
      fikstür verisi henüz yok. Yayınlandığında otomatik olarak listeye girecek.</p>` : "";

  lastList = { href: "#/", label: "Tüm maçlar" };

  // Panel gövde seviyesinde; #view yeniden çizilse de o kapta duruyor.
  paintFilter(meta.leagues);

  const head = `
    <div class="page-head${state.filterOpen ? " filter-open" : ""}">
      <div class="page-title"><h1>Yaklaşan maçlar</h1></div>
      <p class="sub">Önümüzdeki ${meta.window_days} günün maçları · ${predictions} tahmin ·
        <a href="#/model">model ne kadar isabetli?</a></p>
      <div class="filter-wrap">
        <button class="filter-btn" type="button" data-filter="toggle"
                aria-expanded="${state.filterOpen}">
          <span class="f-icon" aria-hidden="true">⚙</span>
          Ligler <b>${shown}/${meta.leagues.length}</b>
        </button>
      </div>
    </div>`;

  if (!all.length) {
    const why = hidden.size
      ? "Seçili ligler gizli. Yukarıdan lig filtresini açıp tekrar göster."
      : "Yaklaşan maç yok.";
    return `${head}${idleNote}<div class="empty">${why}</div>`;
  }

  const counts = new Map();
  for (const m of all) {
    const key = dayKey(m.kickoff);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Şerit kesintisiz olmalı: maçı olmayan günler de görünsün ki kullanıcı
  // takvimde boşluk olduğunu anlasın.
  const first = dayKey(all[0].kickoff);
  const last = dayKey(all[all.length - 1].kickoff);
  const dates = [];
  for (let key = first; key <= last; key = shiftKey(key, 1)) dates.push(key);

  const today = todayKey();
  let selected = state.day;
  if (!selected || !counts.has(selected)) {
    selected = counts.has(today) ? today : dates.find((k) => counts.has(k));
  }

  let start = state.stripStart;
  if (start == null) start = dates.indexOf(selected) - 2;
  start = clamp(start, 0, Math.max(0, dates.length - STRIP_DAYS));

  // Takvimin tek başına yeniden çizilebilmesi için gereken bağlam.
  // Olmazsa ay değiştirmek tüm sayfayı yeniden çizmeyi gerektirirdi.
  state.calCtx = { dates, selected, start, counts };

  const list = all.filter((m) => dayKey(m.kickoff) === selected);

  // Gece yarısını aşan maçlar: bir önceki güne ait olup hâlâ devam edenler
  // seçili günün listesinde yer almıyor ve ekrandan tamamen kayboluyordu.
  // Adayları gizli olarak basıyoruz; applyLive() yalnızca gerçekten devam
  // edenleri açıyor. Böylece canlı durumu bilmeden render edebiliyoruz.
  const previous = shiftKey(selected, -1);
  // Oynanmış maçlar buraya girmemeli: devam eden maç adaylarını arıyoruz.
  const carry = all.filter((m) => !m.score && dayKey(m.kickoff) === previous && liveKey(m));
  const carryHTML = carry.length ? `
    <div class="carry" hidden>
      <div class="date-head carry-head">Önceki günden devam eden</div>
      <div class="match-list">${carry.map(matchRow).join("")}</div>
    </div>` : "";

  // Gün içindeki maçlar lig lig ayrılıyor: karışık bir listede hangi maçın
  // hangi ligden olduğunu okumak zordu. Ligler o gün ilk maçı oynayandan
  // başlayarak sıralanıyor.
  // Favori takımların maçları günün en üstüne sabitleniyor ve lig
  // gruplarından çıkarılıyor — yoksa aynı maç iki kez görünürdü.
  const favs = favourites();
  const isFav = (m) => favs.has(m.home.id) || favs.has(m.away.id);
  const pinned = list.filter(isFav);
  const rest = list.filter((m) => !isFav(m));

  const pinnedHTML = pinned.length ? `
    <div class="date-head pinned-head">★ Favori takımların</div>
    <div class="match-list">${pinned.map(dayRow).join("")}</div>` : "";

  const byLeague = new Map();
  for (const m of rest) {
    if (!byLeague.has(m.league)) byLeague.set(m.league, []);
    byLeague.get(m.league).push(m);
  }
  const names = Object.fromEntries(meta.leagues.map((l) => [l.code, l.name]));
  const groups = [...byLeague.entries()]
    .sort(([, a], [, b]) => a[0].kickoff.localeCompare(b[0].kickoff))
    .map(([code, matches]) => `
      <a class="league-head" href="#/lig/${encodeURIComponent(code)}">
        ${leagueLogo(code)}
        <span class="lh-name">${esc(names[code] ?? code)}</span>
        <span class="lh-count">${matches.length} maç</span>
        <span class="chev" aria-hidden="true">›</span>
      </a>
      <div class="match-list">${matches.map(dayRow).join("")}</div>`).join("");

  return `
    ${head}
    ${idleNote}
    ${dateStripHTML(dates, selected, start, counts)}
    ${carryHTML}
    ${pinnedHTML}
    <div class="date-head">${esc(dayLabel(list[0].kickoff))} · ${list.length} maç ·
      ${new Set(list.map((m) => m.league)).size} lig</div>
    ${groups}`;
}

/** Tahmin penceresinin ötesindeki maçlar: sade fikstür, tahmin yok.
    O kadar ileri tarihte form verisi anlamsız ve saatler de kesin değil. */
async function seasonRestHTML(code, data) {
  let all;
  try {
    all = await getJSON(`${code}-fixtures.json`);
  } catch {
    return "";   // fikstür dosyası yoksa sessizce atlanıyor
  }
  const shown = new Set(data.matches.map((m) => m.id));
  const rest = (all.fixtures ?? []).filter((m) => !shown.has(m.id));
  if (!rest.length) return "";
  return `
    <div class="date-head">Sezonun kalanı · ${rest.length} maç</div>
    <div class="match-list">${rest.map(fixtureRow).join("")}</div>`;
}

async function viewLeague(code, tab) {
  const data = await getJSON(`${code}.json`);
  noteLiveDays(data.matches);
  const base = `#/lig/${encodeURIComponent(code)}`;
  lastList = { href: base, label: data.name, league: code };
  const tabs = [["", "Maçlar"], ["puan", "Puan Durumu"], ["sonuclar", "Sonuçlar"]]
    .map(([slug, label]) => {
      const href = slug ? `${base}/${slug}` : base;
      const current = (tab ?? "") === slug ? ' aria-current="page"' : "";
      return `<a class="tab" href="${href}"${current}>${label}</a>`;
    }).join("");

  let body;
  if (tab === "puan") body = standingsHTML(data);
  else if (tab === "sonuclar") body = resultsHTML(data);
  else {
    // Tahmin penceresi 14 gün; ondan uzaktaki maçlar da fikstür olarak
    // görünsün. Avrupa Ligi 16 Eylül'de, Konferans Ligi 15 Ekim'de
    // başlıyor ve pencereye girmedikleri için sayfaları bomboştu.
    const rest = await seasonRestHTML(code, data);
    const played = playedOn(data, new Set([todayKey()]));
    // Altında yüzlerce maç dururken "oynanacak maç yok" demek anlamsız.
    body = (data.matches.length || played.length || !rest)
      ? matchListHTML(data.matches, played) + rest
      : `<p class="note">Bu yarışma tahmin penceresinin (${data.matches.length
          ? "" : "14 gün"}) dışında başlıyor; aşağıda sezonun tam fikstürü
          var, maçlar yaklaştıkça tahminleri eklenecek.</p>${rest}`;
  }

  const lgResult = data.metrics?.result;
  const measured = lgResult
    ? ` Geriye dönük ölçümde bu ligde 1X2 tahminleri baseline'dan
        %${(lgResult.skill * 100).toFixed(1)} daha iyi (${lgResult.n} maç).` : "";
  const xgNote = data.has_xg === false ? `
    <p class="note">Bu lig için xG verisi bulunmuyor; tahminler yalnızca gol,
      form ve Elo verisine dayanıyor.${measured}</p>` : "";

  // Ölçülmüş kazancı %2'nin altında kalan yarışmalarda tahmin gösteriyoruz
  // ama güvenilir olduğunu iddia etmiyoruz. Avrupa kupaları böyle: takımların
  // çoğunun karşılaştırılabilir bir geçmişi yok ve model orada taban orandan
  // ayrışamıyor.
  const weak = lgResult && lgResult.reliable === false ? `
    <p class="note warn">Model bu yarışmada <strong>güvenilir değil</strong>:
      ${lgResult.n} maçlık ölçümde baseline'dan yalnızca
      %${(lgResult.skill * 100).toFixed(1)} daha iyi çıktı (eşik %2).
      Tahminler gösteriliyor ama bunlara dayanarak karar verme.
      <a href="#/model">ölçümün tamamı</a></p>` : "";

  return `
    <div class="page-head">
      <div class="page-title">${leagueLogo(code)}<h1>${esc(data.name)}</h1></div>
      <p class="sub">${esc(data.season)} sezonu · ${data.matches.length} yaklaşan maç ·
        ${data.results.length} oynanmış</p>
      <nav class="tabs">${tabs}</nav>
    </div>
    ${weak}${xgNote}
    ${body}`;
}

/* ── Canlı tamamlama ───────────────────────────────────────────────────
   Pipeline üç saatte bir çalışıyor; o aralıkta biten maçlar statik veriye
   girmemiş oluyor ve puan durumu ile sonuçlar geride kalıyordu. Canlı skor
   zaten elimizde olduğu için eksik maçları istemci tarafında tamamlıyoruz.
   Kaynak veri değişmiyor, yalnızca gösterim tamamlanıyor. */

/** Statik veriye henüz girmemiş, bitmiş maçlar. */
function freshResults(data) {
  const known = new Set(data.results.map((r) => r.id));
  const out = [];
  for (const m of data.matches ?? []) {
    if (known.has(m.id)) continue;
    const state = liveData.get(liveKey(m) ?? "");
    if (!state?.finished || state.home == null || state.away == null) continue;
    out.push({
      id: m.id, kickoff: m.kickoff, round: m.round,
      home: m.home, away: m.away,
      score: [state.home, state.away],
      xg: null,
      // Maç öncesi tahmin elimizde; isabetini burada hesaplayabiliyoruz.
      forecast: forecastFor(m, state),
      fresh: true,
    });
  }
  return out.sort((a, b) => b.kickoff.localeCompare(a.kickoff));
}

function forecastFor(match, state) {
  const probs = match.markets?.result;
  if (!probs) return null;
  const outcome = state.home > state.away ? 0 : (state.home === state.away ? 1 : 2);
  const pick = probs.indexOf(Math.max(...probs));
  return { probs, pick, hit: pick === outcome };
}

/** Şu anda oynanan maçlar. Puan durumuna geçici olarak işleniyor: tablo,
    skorlar o an geçerliymiş gibi sıralanıyor. Hangi satırın canlı olduğunu
    skor rozeti, sıralamanın nasıl değiştiğini ok gösteriyor. */
function ongoingMatches(data) {
  const out = [];
  for (const m of data.matches ?? []) {
    const state = liveData.get(liveKey(m) ?? "");
    if (!state?.ongoing || state.home == null || state.away == null) continue;
    out.push({ home: m.home, away: m.away, score: [state.home, state.away] });
  }
  return out;
}

/** Puan durumuna, statik veriye girmemiş biten maçları ve devam eden
    maçların anlık skorlarını uygular. */
function standingsWithFresh(data) {
  const fresh = freshResults(data);
  const ongoing = ongoingMatches(data);
  if (!fresh.length && !ongoing.length) {
    return { rows: data.standings, added: 0, live: new Map(), ongoing: 0 };
  }

  const blank = (team) => ({
    team_id: team.id, team: team.name, short: team.short ?? null,
    played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, points: 0,
    xgf: null, xga: null, form: [],
  });

  const build = (matches) => {
    const rows = new Map(data.standings.map((r) => [r.team_id, { ...r, form: [...r.form] }]));
    for (const match of matches) {
      const [hg, ag] = match.score;
      for (const [team, own, other] of [[match.home, hg, ag], [match.away, ag, hg]]) {
        if (!rows.has(team.id)) rows.set(team.id, blank(team));
        const row = rows.get(team.id);
        row.played += 1;
        row.gf += own;
        row.ga += other;
        row.gd = row.gf - row.ga;
        if (own > other) { row.w += 1; row.points += 3; row.form.push("G"); }
        else if (own === other) { row.d += 1; row.points += 1; row.form.push("B"); }
        else { row.l += 1; row.form.push("M"); }
        row.form = row.form.slice(-5);
      }
    }
    const table = [...rows.values()]
      .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
    table.forEach((row, i) => { row.rank = i + 1; });
    return table;
  };

  const table = build([...fresh, ...ongoing]);
  // Ok, YALNIZCA devam eden maçların yol açtığı hareketi gösteriyor: karşılaştırma
  // canlı maçlar uygulanmamış tabloya karşı yapılıyor.
  const before = new Map(build(fresh).map((r) => [r.team_id, r.rank]));

  // Rozet gerçek maç skorunu (ev - deplasman) gösteriyor, rengi ise takımın
  // kendi durumundan alıyor: aynı maçtaki iki takımda yazı aynı, renk farklı.
  const live = new Map();
  for (const m of ongoing) {
    const [hg, ag] = m.score;
    live.set(m.home.id, { score: `${hg} - ${ag}`, own: hg, other: ag });
    live.set(m.away.id, { score: `${hg} - ${ag}`, own: ag, other: hg });
  }
  for (const row of table) {
    const info = live.get(row.team_id);
    if (info) info.move = (before.get(row.team_id) ?? row.rank) - row.rank;
  }
  return { rows: table, added: fresh.length, live, ongoing: ongoing.length };
}

function standingsHTML(data, highlight = null) {
  const { rows: table, added, live, ongoing } = standingsWithFresh(data);
  if (!table.length) return `<div class="empty">Bu sezon henüz maç oynanmadı.</div>`;
  const hasXG = table.some((r) => r.xgf !== null);
  const notes = [];
  if (ongoing) {
    notes.push(`${ongoing} maç şu anda oynanıyor; tablo anlık skorlara göre
                sıralandı, oklar bu maçların yol açtığı hareketi gösteriyor.`);
  }
  if (added) {
    notes.push(`${added} yeni biten maç canlı skorlardan eklendi; xG değerleri
                bir sonraki güncellemede gelecek.`);
  }
  const note = notes.length
    ? `<p class="muted" style="margin:.6rem 0 0;font-size:.78rem">
         ${notes.join(" ")}</p>` : "";

  const badge = (info) => {
    if (!info) return "";
    const cls = info.own > info.other ? "win"
      : info.own === info.other ? "draw" : "loss";
    return `<span class="live-score ${cls}">${info.score}</span>`;
  };
  const arrow = (info) => {
    if (!info?.move) return "";
    const up = info.move > 0;
    return `<span class="rank-move ${up ? "up" : "down"}" title="${Math.abs(info.move)} sıra ${up ? "yükseldi" : "geriledi"}">${up ? "▲" : "▼"}</span>`;
  };

  const rows = table.map((r) => `
    <tr${r.team_id === highlight ? ' class="me"' : ""}>
      <td class="rank">${r.rank}${arrow(live.get(r.team_id))}</td>
      <td><div class="stand-team"><span class="team-cell" data-team="${esc(r.team_id)}">${crest(r.team_id)}${esc(r.team)}</span>${badge(live.get(r.team_id))}</div></td>
      <td>${r.played}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
      <td>${r.gf}:${r.ga}</td><td>${r.gd > 0 ? "+" : ""}${r.gd}</td>
      ${hasXG ? `<td>${r.xgf ?? "—"}</td><td>${r.xga ?? "—"}</td>` : ""}
      <td>${formPills(r.form)}</td><td class="pts">${r.points}</td>
    </tr>`).join("");

  return `<section class="card"><div class="table-scroll"><table>
    <thead><tr>
      <th>#</th><th>Takım</th><th>O</th><th>G</th><th>B</th><th>M</th>
      <th>A:Y</th><th>Av</th>${hasXG ? "<th>xG</th><th>xGA</th>" : ""}<th>Form</th><th>P</th>
    </tr></thead><tbody>${rows}</tbody>
  </table></div>${note}</section>`;
}

/** Sonuçlar hafta hafta; haftalar oklarla kaydırılabilen bir şeritte. */
function resultsHTML(data) {
  // Statik veriye henüz girmemiş biten maçlar canlı skorlardan ekleniyor:
  // pipeline üç saatte bir çalıştığı için o aralıkta biten hafta sonuçlarda
  // hiç görünmüyordu.
  const all = [...freshResults(data), ...data.results];
  if (!all.length) return `<div class="empty">Bu sezon henüz maç oynanmadı.</div>`;

  const weeks = new Map();
  for (const r of all) {
    const key = r.round ?? 0;
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(r);
  }
  const ordered = [...weeks.keys()].sort((a, b) => a - b);
  const selected = weeks.has(state.week) ? state.week : ordered[ordered.length - 1];

  const chips = ordered.map((w) => `
    <button class="week-chip" type="button" data-week="${w}"
            aria-pressed="${w === selected}">${w === 0 ? "Diğer" : `${w}. Hafta`}</button>`).join("");

  const index = ordered.indexOf(selected);
  const nav = (dir, label, disabled) => `
    <button class="strip-nav" type="button" data-weeknav="${dir}" ${disabled ? "disabled" : ""}
            aria-label="${label}">${dir < 0 ? "‹" : "›"}</button>`;

  const list = (weeks.get(selected) ?? []).slice()
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const days = groupByDay(list).map(([, dayList]) => `
    <div class="date-head">${esc(dayLabel(dayList[0].kickoff))}</div>
    <div class="match-list">${dayList.map(resultRow).join("")}</div>`).join("");

  return `
    <div class="week-bar">
      ${nav(-1, "Önceki hafta", index <= 0)}
      <div class="weeks" role="group" aria-label="Hafta seçimi">${chips}</div>
      ${nav(1, "Sonraki hafta", index >= ordered.length - 1)}
    </div>
    ${days}`;
}

function formPills(form) {
  if (!form?.length) return '<span class="muted">—</span>';
  return `<div class="pills">${form.map((f) => `<span class="pill ${f}">${f}</span>`).join("")}</div>`;
}

function barsHTML(probs, market, metrics) {
  const info = reliability(metrics, market.key);
  const best = probs.indexOf(Math.max(...probs));
  const badge = info === null ? ""
    : info.reliable
      ? `<span class="badge">ölçüldü · baseline'dan %${(info.skill * 100).toFixed(1)} iyi</span>`
      : `<span class="badge weak">taban orandan farkı yok</span>`;

  const rows = probs.map((v, i) => `
    <div class="bar-row">
      <span>${esc(market.labels[i])}</span>
      <div class="bar-track">
        <div class="bar-fill ${i === best ? market.fills[i] : ""}" style="width:${(v * 100).toFixed(1)}%"></div>
      </div>
      <span class="bar-pct">%${pct(v)}</span>
    </div>`).join("");

  const warning = info && !info.reliable ? `
    <p class="note">Geriye dönük ölçümde bu market, sabit taban oranı söylemekten
      daha iyi sonuç vermedi (${info.n} maç). Rakamlar model çıktısı olarak
      duruyor ama üzerine karar kurma.</p>` : "";

  return `<section class="card">
    <h2>${esc(market.title)} ${badge}</h2>
    <div class="bars">${rows}</div>
    ${warning}
  </section>`;
}

/** İki takımın aynı ölçüsünü ortadan iki yana büyüyen çubuklarla kıyaslar. */
function compareRow(label, a, b) {
  const fmt = (v) => (v == null ? "—" : v);
  if (a == null || b == null) {
    return `<div class="compare-row">
      <span class="v">${fmt(a)}</span><div></div>
      <span class="lbl">${esc(label)}</span><div></div>
      <span class="v r">${fmt(b)}</span></div>`;
  }
  const total = a + b;
  const share = total > 0 ? (a / total) * 100 : 50;
  return `<div class="compare-row">
    <span class="v">${a}</span>
    <div class="cmp-track left"><div class="cmp-fill" style="width:${share.toFixed(1)}%"></div></div>
    <span class="lbl">${esc(label)}</span>
    <div class="cmp-track right"><div class="cmp-fill" style="width:${(100 - share).toFixed(1)}%"></div></div>
    <span class="v r">${b}</span></div>`;
}

/** Geri bağlantısı: gelinen listeye döner. Doğrudan bağlantıyla açılmışsa
    (elimizde kaynak yoksa) maçın ligine düşer. */
function backLink(data) {
  const sameLeague = lastList.league === data.league;
  const href = lastList.href;
  const label = sameLeague ? data.name : lastList.label;
  const logo = sameLeague || lastList.league ? leagueLogo(lastList.league ?? data.league) : "";
  return `<a class="back" href="${href}"><span class="arrow">←</span>${logo}${esc(label)}</a>`;
}

/** Model olasılıkları ile bahis piyasasının fiyatladığı olasılıkları
    yan yana koyar ve beklenen değeri (EV) gösterir. */
function marketHTML(match) {
  const mk = match.market;
  if (!mk) return "";
  const labels = ["1 · Ev", "X · Beraberlik", "2 · Deplasman"];
  const model = match.markets.result;

  const rows = labels.map((label, i) => {
    const ev = mk.ev[i];
    const cls = ev > 0 ? "pos" : "";
    return `<tr>
      <td>${esc(label)}</td>
      <td>%${pct(model[i])}</td>
      <td>%${pct(mk.probs[i])}</td>
      <td>${mk.best_odds[i].toFixed(2)}</td>
      <td class="${cls}">${ev > 0 ? "+" : ""}${(ev * 100).toFixed(1)}%</td>
    </tr>`;
  }).join("");

  const edges = mk.ev.filter((v) => v > 0).length;
  return `<section class="card">
    <h2>Model ve piyasa
      <span class="badge">${mk.bookmakers} bahisçi · marj %${(mk.margin * 100).toFixed(1)}</span>
    </h2>
    <div class="table-scroll"><table class="table-metrics market-table">
      <thead><tr><th>Sonuç</th><th>Model</th><th>Piyasa</th><th>En iyi oran</th><th>EV</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">
      Piyasa sütunu, ${mk.bookmakers} bahisçinin oranlarından kâr marjı
      temizlenerek hesaplandı. EV pozitifse model o sonuca piyasanın
      fiyatladığından daha yüksek ihtimal veriyor demektir.
      ${edges ? "" : "Bu maçta modelin piyasadan ayrıştığı bir sonuç yok."}
      <strong>Bu bir kâr vaadi değil:</strong> modelin bahis piyasasını gerçekten
      geçip geçmediği tahminler sonuçlandıkça ölçülüyor ve
      <a href="#/model">açıkça yayınlanıyor</a>.
    </p>
  </section>`;
}

/* ─── Maç akışı ve istatistikler ─────────────────────────────────────────
   Hem canlı hem oynanmış maçlarda gösteriliyor. Veri worker'dan geliyor:
   canlı maçta FotMob maç kimliği elimizde (canlı listeden), oynanmışta yok --
   o yüzden worker maçı tarih + takım kimliğiyle de bulabiliyor.

   Sayfa bu çağrıyı BEKLEMİYOR: önce boş bir yer tutucu basılıyor, veri
   gelince dolduruluyor. Aksi halde proxy yavaşken maç sayfası hiç açılmıyordu. */

/** Başlamış maçta iki sekme: olan biten ve tahmin. Maç oynanırken önce
    olasılık tablosunu göstermek yanlış sıra; oynanmamış maçta ise
    gösterilecek başka bir şey yok, sekme de çıkmıyor. */
function matchTabs(base, tab) {
  const items = [["", "Maç"], ["tahmin", "Tahmin"]].map(([slug, label]) => {
    const href = slug ? `${base}/${slug}` : base;
    const current = (tab ?? "") === slug ? ' aria-current="page"' : "";
    return `<a class="tab" href="${href}"${current}>${label}</a>`;
  }).join("");
  return `<nav class="tabs match-tabs">${items}</nav>`;
}

function detailSlot(match) {
  const live = liveData.get(liveKey(match) ?? "");
  const query = live?.matchId
    ? `matchId=${encodeURIComponent(live.matchId)}`
    : (match.home?.fm && match.away?.fm)
      ? `date=${fotmobDay(match.kickoff)}&home=${encodeURIComponent(match.home.fm)}`
        + `&away=${encodeURIComponent(match.away.fm)}`
      : null;
  if (!query || !goalProxy) return "";
  // Kadro başlıklarında takım adı gerekiyor; yer tutucuda taşınıyor ki
  // dolduran fonksiyonun maçı yeniden bulmasına gerek kalmasın.
  const names = JSON.stringify({ home: { name: match.home.name },
                                 away: { name: match.away.name } });
  return `<div id="match-detail" data-query="${esc(query)}"
               data-match="${esc(names)}"></div>`;
}

/** Dakikalar ortada, ev sahibi olayları solda, deplasman sağda. Hangi tarafın
    olayı olduğu satırın hangi yanında durduğundan anlaşılıyor. */
function timelineHTML(timeline) {
  if (!timeline?.length) return "";
  const rows = timeline.map((e) => {
    if (e.t === "devre") {
      const label = e.label === "HT" ? "İY" : e.label === "FT" ? "MS" : esc(e.label);
      return `<div class="tl-band">${label} ${e.score[0]} - ${e.score[1]}</div>`;
    }
    if (e.t === "uzatma") {
      return e.mins ? `<div class="tl-band soft">+${e.mins} dakika uzatma</div>` : "";
    }
    const body = eventBody(e);
    if (!body) return "";
    const minute = e.add ? `${e.m}+${e.add}'` : `${e.m}'`;
    return `<div class="tl-row">
      <div class="tl-side left">${e.home ? body : ""}</div>
      <div class="tl-min">${minute}</div>
      <div class="tl-side right">${e.home ? "" : body}</div>
    </div>`;
  });
  return `<section class="card">
    <h2>Maç akışı</h2>
    <div class="timeline">${rows.join("")}</div>
  </section>`;
}

/* VAR kararlarının Türkçesi. Listede olmayan bir karar gelirse FotMob'un
   kendi İngilizce metni gösteriliyor: çevrilmemiş göstermek, hiç
   göstermemekten iyi. Sözlük gerçek maçlardan toplandı. */
const VAR_WORDS = {
  var_goal_cancelled: "gol iptal",
  var_goal_awarded: "gol verildi",
  var_goal_confirmed: "gol onaylandı",
  var_penalty_cancelled: "penaltı iptal",
  var_penalty_awarded: "penaltı verildi",
  var_penalty_confirmed: "penaltı onaylandı",
  var_penalty_miss_retake: "penaltı tekrarlanacak",
  var_red_card_given: "kırmızı kart",
  var_red_card_cancelled: "kırmızı kart iptal",
  var_card_upgrade: "kart yükseltildi",
  offside: "ofsayt",
  no_offside: "ofsayt yok",
  foul: "faul",
  no_foul: "faul yok",
  handball: "el",
  no_handball: "el yok",
};

function varText(e) {
  const parts = (e.keys ?? []).map((key, i) => VAR_WORDS[key] ?? e.words?.[i] ?? key);
  if (parts.length) return parts.join(" · ");
  // Karar henüz verilmemiş: canlı maçta hakem ekrana giderken bu durum
  // birkaç dakika sürüyor.
  return e.pending ? "inceleniyor" : "";
}

function eventBody(e) {
  if (e.t === "gol") {
    const marks = `${e.pen ? " (P)" : ""}${e.own ? " (KK)" : ""}`;
    const score = e.score ? `<b class="tl-score">${e.score[0]} - ${e.score[1]}</b>` : "";
    return `<span class="tl-ico" aria-hidden="true">⚽</span>`
      + `<span class="tl-name">${esc(e.name)}${marks}</span>${score}`;
  }
  if (e.t === "kart") {
    const title = e.card === "ikinci" ? "İkinci sarıdan kırmızı"
      : e.card === "kirmizi" ? "Kırmızı kart" : "Sarı kart";
    return `<span class="tl-card ${e.card}" title="${title}"></span>`
      + `<span class="tl-name">${esc(e.name)}</span>`;
  }
  if (e.t === "degisiklik") {
    // Okların kendisi zaten değişikliği anlatıyor; ayrıca simge koymak
    // satırı gereksiz kalabalıklaştırıyordu.
    return `<span class="tl-name"><i class="in">${esc(e.in)}</i>`
      + `<i class="out">${esc(e.out)}</i></span>`;
  }
  if (e.t === "var") {
    const what = varText(e);
    return `<span class="tl-var">VAR</span>`
      + `<span class="tl-name">${esc(e.name)}`
      + (what ? `<i class="tl-why">${esc(what)}</i>` : "") + `</span>`;
  }
  return "";
}

/** Çubuk, iki takımın payını gösteriyor. Sayısal olmayan değerlerde
    ("562 (89%)") baştaki sayı alınıyor; alınamazsa çubuk çizilmiyor. */
function statsHTML(stats) {
  if (!stats?.length) return "";
  const rows = stats.map((s) => {
    const h = Number.parseFloat(s.home), a = Number.parseFloat(s.away);
    const total = (Number.isFinite(h) ? h : 0) + (Number.isFinite(a) ? a : 0);
    const share = Number.isFinite(h) && Number.isFinite(a) && total > 0
      ? (h / total) * 100 : null;
    return `<div class="stat-row">
      <div class="stat-head"><b>${esc(s.home)}</b>
        <span>${esc(s.label)}</span><b>${esc(s.away)}</b></div>
      ${share === null ? "" : `<div class="stat-bar"><i style="width:${share.toFixed(1)}%"></i></div>`}
    </div>`;
  });
  return `<section class="card"><h2>İstatistikler</h2>${rows.join("")}</section>`;
}

/* Kadrolar. Oynanmamış maçta FotMob tahmini 11'i veriyor; bunu kesin
   kadro gibi göstermek yanlış olur, o yüzden başlıkta hangisi olduğu
   yazıyor. */
const LINEUP_KIND = {
  standard: null,
  confirmed: null,
  predicted: "tahmini kadro",
  lastStarting11: "son maçın 11'i",
};

const OUT_REASON = {
  injury: "sakat",
  suspension: "cezalı",
  suspended: "cezalı",
  national: "milli takımda",
  other: "yok",
};

function playerRow(p, side) {
  const no = p.no ? `<span class="pl-no">${esc(String(p.no))}</span>` : "";
  const cap = p.cap ? `<span class="pl-cap" title="Kaptan">K</span>` : "";
  return `<li class="pl ${side}">${no}<span class="pl-name">${esc(p.n)}</span>${cap}</li>`;
}

function lineupHTML(lineup, match) {
  if (!lineup?.home?.starters?.length && !lineup?.away?.starters?.length) return "";
  const note = LINEUP_KIND[lineup.type];
  const col = (team, side, name) => {
    if (!team) return "<div></div>";
    return `<div class="lu-col ${side}">
      <div class="lu-head">
        <b>${esc(name)}</b>
        ${team.formation ? `<span class="lu-form">${esc(team.formation)}</span>` : ""}
      </div>
      <ul class="lu-list">${team.starters.map((p) => playerRow(p, side)).join("")}</ul>
      ${team.subs.length ? `<div class="lu-sub-head">Yedekler</div>
        <ul class="lu-list subs">${team.subs.map((p) => playerRow(p, side)).join("")}</ul>` : ""}
      ${team.coach ? `<div class="lu-coach">Teknik direktör · ${esc(team.coach)}</div>` : ""}
    </div>`;
  };
  const missing = (team, name) => {
    if (!team?.out?.length) return "";
    return `<div class="lu-out">
      <b>${esc(name)}</b>
      <span>${team.out.map((p) => `${esc(p.n)}<i>${
        esc(OUT_REASON[p.why] ?? p.why ?? "yok")}</i>`).join(", ")}</span>
    </div>`;
  };
  const outs = missing(lineup.home, match.home.name) + missing(lineup.away, match.away.name);

  return `<section class="card">
    <h2>Kadrolar${note ? ` <span class="badge soft">${esc(note)}</span>` : ""}</h2>
    <div class="lineups">
      ${col(lineup.home, "h", match.home.name)}
      ${col(lineup.away, "a", match.away.name)}
    </div>
    ${outs ? `<div class="lu-outs"><div class="lu-out-head">Eksikler</div>${outs}</div>` : ""}
  </section>`;
}

let detailBusy = "";

async function fillMatchDetail() {
  const slot = document.getElementById("match-detail");
  if (!slot || !goalProxy) return;
  const query = slot.dataset.query;
  if (detailBusy === query && slot.innerHTML) return;
  detailBusy = query;
  try {
    const response = await fetch(`${goalProxy}?${query}`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    // Sayfa bu arada değişmiş olabilir.
    const still = document.getElementById("match-detail");
    if (!still || still.dataset.query !== query) return;
    still.innerHTML = timelineHTML(payload.timeline)
      + lineupHTML(payload.lineup, JSON.parse(still.dataset.match))
      + statsHTML(payload.stats);
  } catch { /* akış gösterilemezse sayfanın geri kalanı çalışmaya devam eder */ }
}

/** Oynanmış maçın sayfası: skor, maç öncesi tahminin tutup tutmadığı,
    maç akışı ve istatistikler. Tahmin sayfasından ayrı çünkü gösterilecek
    şey farklı — olasılıklar artık bir öngörü değil, bir kayıt. */
function viewResult(result, data, meta, tab) {
  const [hg, ag] = result.score;
  const f = result.forecast;
  const week = result.round ? ` · ${result.round}. Hafta` : "";

  const verdict = !f ? "" : `
    <section class="card">
      <h2>Model ne demişti?</h2>
      <div class="verdict ${f.hit ? "hit" : "miss"}">
        <span class="mark">${f.hit ? "✓" : "✗"}</span>
        <div>
          <b>${["Ev sahibi kazanır", "Beraberlik", "Deplasman kazanır"][f.pick]}</b>
          <span class="muted"> · %${pct(f.probs[f.pick])} ihtimal veriyordu</span>
          <div class="verdict-all">
            ${["1", "X", "2"].map((label, i) =>
              `<span class="${i === f.pick ? "pick" : ""}">${label} %${pct(f.probs[i])}</span>`
            ).join("")}
          </div>
        </div>
      </div>
      <p class="note">Bu olasılıklar maç oynanmadan önce hesaplandı ve
        değiştirilemez şekilde kaydedildi.
        <a href="#/model">Modelin genel isabeti</a></p>
    </section>`;

  return `
    ${backLink(data)}

    <div class="match-hero">
      <div class="hero-names">
        <div class="hero-team">
          ${crest(result.home.id, "lg")}
          <strong><span class="team-name" data-team="${esc(result.home.id)}">${esc(result.home.name)}</span></strong>
        </div>
        <div class="hero-mid">
          <strong class="hero-score final">${hg}<span class="dash">–</span>${ag}</strong>
          ${esc(dayLabel(result.kickoff))}${week}
          ${result.xg ? `<span class="muted">xG ${result.xg[0]} - ${result.xg[1]}</span>` : ""}
        </div>
        <div class="hero-team">
          ${crest(result.away.id, "lg")}
          <strong><span class="team-name" data-team="${esc(result.away.id)}">${esc(result.away.name)}</span></strong>
        </div>
      </div>
    </div>

    ${verdict ? matchTabs(`#/mac/${encodeURIComponent(result.id)}`, tab) : ""}
    ${!verdict || (tab ?? "") !== "tahmin" ? detailSlot(result) : verdict}`;
}

/* Modelin cümlesi.

   Olasılıkları gizlemiyoruz — kalibrasyonları ölçüldü ve doğrular — ama
   "%36 %27 %37" tek başına hiçbir şey söylemiyor. Öte yandan düz bir
   "ev sahibi kazanır" da yanlış olurdu: ölçümde modelin güveni %50'nin
   altındayken o cümle yalnızca %43 tutuyor, yani üç maçın ikisinde yanlış.

   Çözüm, cümleyi modelin GERÇEKTEN bildiği kadarına göre kurmak. Eşikler
   uydurulmuyor: hangi güven diliminde tek seçimin ne kadar tuttuğu
   backtest'te ölçülüp meta.json'a yazılıyor, buradaki mantık o rakama
   bakıyor. Model iyileşirse cümleler kendiliğinden güçleniyor. */

function verdictHTML(match, meta) {
  const p = match.markets?.result;
  const bands = meta.confidence ?? [];
  if (!p || !bands.length) return "";

  const conf = Math.max(...p);
  const band = bands.find((b) => conf >= b.lo && conf < b.hi) ?? bands.at(-1);

  // Beraberlik hiçbir zaman en olası sonuç olmuyor, dolayısıyla favori ya ev
  // ya deplasman.
  const favHome = p[0] >= p[2];
  const fav = favHome ? match.home : match.away;
  const pFav = favHome ? p[0] : p[2];
  const safe = pFav + p[1];

  const name = esc(fav.name);
  const single = `<b>${name} kazanır</b><span class="v-pct">%${pct(pFav)}</span>`;
  const survives = `<b>${name} kaybetmez</b><span class="v-pct">%${pct(safe)}</span>`;
  const measured = `Geriye dönük ölçümde bu güvendeki
    ${band.n.toLocaleString("tr-TR")} maçta`;

  if (band.single >= 0.60) {
    return `<section class="card verdict-card strong">
      <h2>Model ne diyor?</h2>
      <p class="v-main">${single}</p>
      <p class="v-alt">${survives}</p>
      <p class="note">${measured} bu tahmin %${pct(band.single)} tuttu;
        "kaybetmez" ifadesi %${pct(band.double)}.</p>
    </section>`;
  }
  if (band.single >= 0.50) {
    return `<section class="card verdict-card mid">
      <h2>Model ne diyor?</h2>
      <p class="v-main"><b>${name} favori</b><span class="v-pct">%${pct(pFav)}</span></p>
      <p class="v-alt">${survives}</p>
      <p class="note">${measured} tek sonuç seçmek %${pct(band.single)} tuttu —
        yani yaklaşık her iki maçtan birinde yanlış. "Kaybetmez" ifadesi
        %${pct(band.double)} tuttu.</p>
    </section>`;
  }
  return `<section class="card verdict-card open">
    <h2>Model ne diyor?</h2>
    <p class="v-main"><b>Açık maç</b></p>
    <p class="v-alt">${survives}</p>
    <p class="note">${measured} tek sonuç seçmek yalnızca %${pct(band.single)}
      tuttu. Model burada net bir şey söyleyemiyor; söyleyebildiği en
      güvenilir şey yukarıdaki ("kaybetmez" ölçümde %${pct(band.double)}).</p>
  </section>`;
}

async function viewMatch(id, tab) {
  const meta = await getJSON("meta.json");
  let match = null, data = null;
  for (const league of meta.leagues) {
    if (!league.upcoming) continue;
    const candidate = await getJSON(`${league.code}.json`);
    const found = candidate.matches.find((m) => m.id === id);
    if (found) { match = found; data = candidate; break; }
  }
  if (!match) {
    // Oynanmış maçlar tahmin listesinden düşüyor ama sonuçlarda duruyor;
    // maç akışı ve istatistikler orada da gösteriliyor.
    for (const league of meta.leagues) {
      const candidate = await getJSON(`${league.code}.json`);
      const found = (candidate.results ?? []).find((m) => m.id === id);
      if (found) return viewResult(found, candidate, meta, tab);
    }
    return `<a class="back" href="#/"><span class="arrow">←</span>Maçlar</a>
      <div class="empty">Bu maç bulunamadı.</div>`;
  }

  const standing = Object.fromEntries(data.standings.map((r) => [r.team_id, r]));
  const [lh, la] = match.lambdas;
  const [ph, pd, pa] = match.markets.result;
  const top = match.top_scores[0];
  const rest = match.top_scores.slice(1, 5);

  const tbd = match.time_confirmed === false
    ? `<p class="note">Başlama saati henüz kesinleşmedi, değişebilir.</p>` : "";

  const week = match.round ? ` · ${match.round}. Hafta` : "";
  const info = reliability(meta.metrics, "result");

  const base = `#/mac/${encodeURIComponent(id)}`;
  // Canlı liste yalnızca başlamış maçları taşıyor; orada varsa maç başlamış
  // demektir. Başlamamışta gösterilecek akış ya da istatistik yok.
  const started = !!liveData.get(liveKey(match) ?? "");

  const hero = `
    <div class="match-hero"${liveKey(match) ? ` data-live="${liveKey(match)}"` : ""}
         data-fmday="${fotmobDay(match.kickoff)}">
      <div class="hero-names">
        <div class="hero-team">
          ${crest(match.home.id, "lg")}
          <strong><span class="team-name" data-team="${esc(match.home.id)}">${esc(match.home.name)}</span><span class="cards-h"></span></strong>
          <span>Elo ${match.home.elo}</span>
          <span class="scorers goals-h"></span>
        </div>
        <div class="hero-mid">
          <!-- Canlı skor alanları applyLive() ile doluyor; maç başlamadıysa
               gizli kalıyor ve yerinde başlama saati duruyor. -->
          <strong class="hero-score">
            <span class="live-h"></span><span class="dash">–</span><span class="live-a"></span>
          </strong>
          <strong class="clock">${timeIn(match.kickoff)}</strong>
          ${esc(dayLabel(match.kickoff))}${week}
        </div>
        <div class="hero-team">
          ${crest(match.away.id, "lg")}
          <strong><span class="team-name" data-team="${esc(match.away.id)}">${esc(match.away.name)}</span><span class="cards-a"></span></strong>
          <span>Elo ${match.away.elo}</span>
          <span class="scorers goals-a"></span>
        </div>
      </div>

      <div class="prob-bar" role="img"
           aria-label="Ev %${pct(ph)}, beraberlik %${pct(pd)}, deplasman %${pct(pa)}">
        <div class="prob-seg home" style="flex:${ph}">%${pct(ph)}</div>
        <div class="prob-seg draw" style="flex:${pd}">%${pct(pd)}</div>
        <div class="prob-seg away" style="flex:${pa}">%${pct(pa)}</div>
      </div>
      <div class="prob-legend">
        <span><i style="background:var(--home)"></i>Ev sahibi kazanır</span>
        <span><i style="background:var(--draw-1x2)"></i>Beraberlik</span>
        <span><i style="background:var(--away)"></i>Deplasman kazanır</span>
      </div>
    </div>`;

  const prediction = `
    ${tbd}
    ${verdictHTML(match, meta)}

    <section class="card">
      <h2>En olası skor ${info?.reliable
        ? `<span class="badge">1X2 ölçüldü · baseline'dan %${(info.skill * 100).toFixed(1)} iyi</span>` : ""}</h2>
      <div class="headline">
        <div>
          <div class="headline-score">${top.home} - ${top.away}</div>
          <div class="headline-meta">%${(top.prob * 100).toFixed(1)} olasılık</div>
        </div>
        <div class="headline-meta">
          Beklenen gol<br>
          <b>${lh.toFixed(2)}</b> ${esc(match.home.short || match.home.name)} ·
          <b>${la.toFixed(2)}</b> ${esc(match.away.short || match.away.name)}
        </div>
      </div>
      <div class="scores" style="margin-top:.9rem">
        ${rest.map((s) => `<div class="score-cell">
          <b>${s.home} - ${s.away}</b><span>%${(s.prob * 100).toFixed(1)}</span></div>`).join("")}
      </div>
    </section>

    ${marketHTML(match)}

    ${SIDE_MARKETS.map((m) => barsHTML(match.markets[m.key], m, meta.metrics)).join("")}

    <section class="card">
      <h2>Takım karşılaştırması</h2>
      <div class="compare-head">
        <span class="t">${crest(match.home.id)}<span>${esc(match.home.name)}</span></span>
        <span class="muted" style="font-size:.7rem">son 10 maç</span>
        <span class="t r"><span>${esc(match.away.name)}</span>${crest(match.away.id)}</span>
      </div>
      <div class="compare">
        ${COMPARE_ROWS.map((r) => compareRow(r.label, r.pick(match.home), r.pick(match.away))).join("")}
      </div>
      <div class="form-grid" style="margin-top:1.1rem">
        ${[match.home, match.away].map((team) => {
          const row = standing[team.id];
          return `<div class="form-col">
            <h3>${esc(team.name)}${row ? ` · ${row.rank}. sıra, ${row.points} puan` : ""}</h3>
            ${formPills(row?.form)}</div>`;
        }).join("")}
      </div>
    </section>`;

  return `
    ${backLink(data)}
    ${hero}
    ${started ? matchTabs(base, tab) : ""}
    ${started && (tab ?? "") !== "tahmin" ? detailSlot(match) : prediction}`;
}

/** Tahmin penceresi dışındaki maç: sade fikstür satırı. Tahmin yok, çünkü
    o kadar ileri tarihte form verisi anlamsız ve saatler de kesin değil. */
function fixtureRow(match, index = 0) {
  const day = new Date(match.kickoff).toLocaleDateString("tr-TR", {
    timeZone: TZ, day: "numeric", month: "short",
  });
  return `
    <div class="match fixture" style="--i:${index}">
      <div class="match-time">
        <span class="fx-date">${esc(day)}</span>
        ${match.round ? `<span class="fx-round">${match.round}. hf</span>` : ""}
      </div>
      <div class="match-teams">
        <div class="team-line">${crest(match.home.id)}<span class="team-name" data-team="${esc(match.home.id)}">${esc(match.home.name)}</span></div>
        <div class="team-line">${crest(match.away.id)}<span class="team-name" data-team="${esc(match.away.id)}">${esc(match.away.name)}</span></div>
      </div>
      <div class="match-markets"></div>
      <div class="chev"></div>
    </div>`;
}

/** Tek takımın sayfası: yaklaşan maçları, sonuçları ve puan durumundaki yeri.
    Ek veri gerekmiyor — lig JSON'u zaten hepsini taşıyor, takıma göre
    süzüyoruz. */
/** Takımın sezonu, yarışma yarışma.

    Kupa ve lig maçları ayrı dosyalarda; takımın Avrupa maçlarını görmek için
    bütün yarışmaların taranması gerekiyor. Dosyalar `getJSON` içinde
    önbellekli, yani ilk gezinmeden sonra ek ağ trafiği yok.

    Sıra: önce takımın kendi ligi, sonra Avrupa kupaları, sonra kalanlar --
    kullanıcının aradığı şey neredeyse her zaman ilk ikisi. */
async function teamSeason(id, meta, ownLeague) {
  const involves = (m) => m.home?.id === id || m.away?.id === id;
  const order = (l) => (l.code === ownLeague ? 0 : (l.tier ?? 0) === 1 ? 1 : 2);
  const out = [];

  for (const lg of [...meta.leagues].sort((a, b) => order(a) - order(b))) {
    let data;
    try {
      data = await getJSON(`${lg.code}.json`);
    } catch { continue; }

    const played = [...freshResults(data), ...(data.results ?? [])].filter(involves);
    const upcoming = (data.matches ?? []).filter(involves);
    let rest = [];
    if (upcoming.length || played.length) {
      // Fikstür dosyası yalnızca takımın gerçekten oynadığı yarışmalar için
      // isteniyor; yirmi dosyayı boşuna indirmemek için.
      try {
        const all = await getJSON(`${lg.code}-fixtures.json`);
        const shown = new Set(upcoming.map((m) => m.id));
        rest = (all.fixtures ?? []).filter((m) => involves(m) && !shown.has(m.id));
      } catch { /* fikstür dosyası olmayabilir */ }
    }
    if (played.length || upcoming.length || rest.length) {
      out.push({ code: lg.code, name: lg.name, played, upcoming, rest });
    }
  }
  return out;
}

/** Yarışma başlığı + oynanmışlar + sezonun kalanı. */
function competitionBlock(comp, id) {
  const total = comp.played.length + comp.upcoming.length + comp.rest.length;
  const head = `<a class="league-head" href="#/lig/${encodeURIComponent(comp.code)}">
    ${leagueLogo(comp.code)}<span class="lh-name">${esc(comp.name)}</span>
    <span class="lh-count">${total} maç</span>
    <span class="chev" aria-hidden="true">›</span></a>`;

  const playedRows = comp.played.length ? `
    <div class="date-head">Oynanmış maçlar · ${comp.played.length}</div>
    <div class="match-list">${comp.played
      .map((m, i) => resultRow(m, i, id)).join("")}</div>` : "";

  // Tahminli maçlar önce, sonra pencerenin ötesindeki sade fikstür.
  const ahead = [...comp.upcoming.map((m, i) => matchRow(m, i)),
                 ...comp.rest.map((m, i) => fixtureRow(m, i))];
  const aheadRows = ahead.length ? `
    <div class="date-head">Sezonun kalanı · ${ahead.length}</div>
    <div class="match-list">${ahead.join("")}</div>` : "";

  return head + playedRows + aheadRows;
}

async function viewTeam(id, tab) {
  const teams = await loadTeams();
  const team = teams.find((t) => t.id === id);
  if (!team) {
    return `<a class="back" href="#/"><span class="arrow">←</span>Maçlar</a>
      <div class="empty">Takım bulunamadı.</div>`;
  }

  const data = await getJSON(`${team.league}.json`);
  noteLiveDays(data.matches);
  const meta = await getJSON("meta.json");
  const leagueName = meta.leagues.find((l) => l.code === team.league)?.name ?? team.league;
  const involves = (m) => m.home.id === id || m.away.id === id;

  const upcoming = data.matches.filter(involves);

  // Tam sezon fikstürü ayrı dosyada; yalnızca burada isteniyor. Tahmin
  // penceresindeki maçlar zaten `upcoming` içinde tahminleriyle var, onları
  // tekrar göstermiyoruz.
  let fixtures = [];
  try {
    const all = await getJSON(`${team.league}-fixtures.json`);
    const shown = new Set(upcoming.map((m) => m.id));
    fixtures = (all.fixtures ?? []).filter((m) => involves(m) && !shown.has(m.id));
  } catch { /* fikstür dosyası yoksa sadece tahminli maçlar gösterilir */ }
  const played = [...freshResults(data), ...data.results].filter(involves);
  const row = data.standings.find((r) => r.team_id === id);
  const fav = favourites().has(id);

  const rank = row
    ? `${row.rank}. sıra · ${row.points} puan · ${row.played} maç`
    : "bu sezon henüz maç oynamadı";

  const upcomingHTML = upcoming.length
    ? groupByDay(upcoming).map(([, day]) => `
        <div class="date-head">${esc(dayLabel(day[0].kickoff))}</div>
        <div class="match-list">${day.map(matchRow).join("")}</div>`).join("")
    : `<div class="empty">Tahmin penceresinde maçı yok.</div>`;

  const base = `#/takim/${encodeURIComponent(id)}`;
  const tabs = [["", "Maçlar"], ["fikstur", "Fikstür"], ["puan", "Puan Durumu"]]
    .map(([slug, label]) => {
      const href = slug ? `${base}/${slug}` : base;
      const current = (tab ?? "") === slug ? ' aria-current="page"' : "";
      return `<a class="tab" href="${href}"${current}>${label}</a>`;
    }).join("");

  // Sonuçlar gün gün: sezon ilerledikçe yalnızca saat göstermek hangi maçın
  // ne zaman oynandığını belirsiz bırakıyor.
  // Fikstür sekmesi takımın BÜTÜN yarışmalarını gösteriyor: lig, Avrupa
  // kupası, hepsi ayrı başlık altında ve her birinde önce oynanmışlar sonra
  // sezonun kalanı. Eskiden yalnızca kendi liginin kalan maçları vardı.
  const season = await teamSeason(id, meta, team.league);
  const fixtureHTML = season.length
    ? season.map((c) => competitionBlock(c, id)).join("")
    : `<div class="empty">Bu sezon için maç bulunamadı.</div>`;

  // Puan tablosu takım sayfasında da var: takımın ligde nerede olduğunu
  // görmek için başka sayfaya gitmek gerekmesin. Takımın satırı vurgulu.
  const tableHTML = standingsHTML(data, id);

  const playedHTML = played.length
    ? groupByDay(played).reverse().map(([, day]) => `
        <div class="date-head">${esc(dayLabel(day[0].kickoff))}</div>
        <div class="match-list">${day.map((m, i) => resultRow(m, i, id)).join("")}</div>`).join("")
    : "";

  return `
    <a class="back" href="${lastList.href}"><span class="arrow">←</span>${esc(lastList.label)}</a>

    <div class="team-hero">
      ${crest(id, "lg")}
      <div class="team-hero-text">
        <h1>${esc(team.name)}</h1>
        <p class="sub">
          <a href="#/lig/${encodeURIComponent(team.league)}">${esc(leagueName)}</a> · ${esc(rank)}
        </p>
        ${row ? `<div class="pills">${row.form.map((f) =>
          `<span class="pill ${f}">${f}</span>`).join("")}</div>` : ""}
      </div>
      <button class="star team-star" type="button" data-fav="${esc(id)}"
              aria-pressed="${fav}"
              aria-label="${fav ? "Favorilerden çıkar" : "Favorilere ekle"}">★</button>
    </div>

    <nav class="tabs team-tabs">${tabs}</nav>
    ${tab === "puan" ? tableHTML
      : tab === "fikstur"
        ? fixtureHTML
        : `${upcomingHTML}${playedHTML}`}`;
}

async function liveRecordHTML() {
  let data;
  try { data = await getJSON("accuracy.json"); } catch { return ""; }
  const vs = data.vs_market;
  const vsHTML = vs ? `<section class="card">
    <h2>Model ve bahis piyasası
      <span class="badge${vs.model_better ? "" : " weak"}">
        ${vs.model_better ? "model önde" : "piyasa önde"}</span></h2>
    <div class="bars">
      <div class="bar-row"><span>Model</span>
        <div class="bar-track"><div class="bar-fill ${vs.model_better ? "yes" : ""}"
          style="width:${Math.min(100, (1 - vs.model_logloss / 1.2) * 100).toFixed(1)}%"></div></div>
        <span class="bar-pct">${vs.model_logloss.toFixed(4)}</span></div>
      <div class="bar-row"><span>Piyasa</span>
        <div class="bar-track"><div class="bar-fill ${vs.model_better ? "" : "yes"}"
          style="width:${Math.min(100, (1 - vs.market_logloss / 1.2) * 100).toFixed(1)}%"></div></div>
        <span class="bar-pct">${vs.market_logloss.toFixed(4)}</span></div>
    </div>
    <p class="note">Aynı ${vs.n} maçta, aynı ölçüyle (logloss — düşük olan iyi).
      Baseline'ı geçmek kolaydır; asıl zor olan bahis piyasasını geçmektir, çünkü
      oranlar sakatlık ve kadro bilgisini de içerir. ${vs.since} tarihinden beri
      biriken bu kıyas, tahminler maçtan önce kaydedildiği için geriye dönük
      değiştirilemez.</p>
  </section>` : "";

  const markets = Object.values(data.markets ?? {});
  if (!markets.length) {
    return vsHTML + `<section class="card">
      <h2>Yayındaki isabet</h2>
      <p class="muted" style="margin:0">Henüz sonuçlanmış tahmin yok. Site
        yayınlandıktan sonra her tahmin kaydediliyor ve maç bitince sonucuyla
        eşleştiriliyor; bu tablo maçlar oynandıkça kendiliğinden dolacak.</p>
    </section>`;
  }
  const rows = markets.map((m) => `
    <tr><td>${esc(m.label)}</td><td>${m.n}</td>
      <td>%${(m.accuracy * 100).toFixed(1)}</td>
      <td>%${(m.baseline_accuracy * 100).toFixed(1)}</td>
      <td>${m.logloss.toFixed(4)}</td><td>${esc(m.since)}</td></tr>`).join("");
  return vsHTML + `<section class="card">
    <h2>Yayındaki isabet <span class="badge">${data.total} tahmin doğrulandı</span></h2>
    <div class="table-scroll"><table class="table-metrics">
      <thead><tr><th>Market</th><th>Tahmin</th><th>İsabet</th>
        <th>Baseline</th><th>Logloss</th><th>Başlangıç</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted" style="margin:.75rem 0 0;font-size:.8rem">
      Bu tahminler maç oynanmadan önce kaydedildi ve sonradan değiştirilmedi.</p>
  </section>`;
}

async function viewModel() {
  const meta = await getJSON("meta.json");
  const live = await liveRecordHTML();
  const rows = Object.values(meta.metrics ?? {}).map((m) => `
    <tr><td>${esc(m.label)}</td><td>${m.n}</td>
      <td>${m.logloss.toFixed(4)}</td><td>${m.baseline_logloss.toFixed(4)}</td>
      <td>${(m.skill * 100).toFixed(1)}%</td>
      <td>%${(m.accuracy * 100).toFixed(1)}</td>
      <td>%${(m.baseline_accuracy * 100).toFixed(1)}</td>
      <td>${m.reliable ? '<span class="badge">güvenilir</span>'
                       : '<span class="badge weak">edge yok</span>'}</td></tr>`).join("");

  return `
    <a class="back" href="#/"><span class="arrow">←</span>Maçlar</a>
    <div class="page-head">
      <div class="page-title"><h1>Model ne kadar iyi?</h1></div>
      <p class="sub">Walk-forward ölçüm: her sezon, yalnızca kendisinden önce
        oynanmış maçlarla eğitilen modelle tahmin edildi.</p>
    </div>
    ${live}
    <section class="card">
      <div class="table-scroll"><table class="table-metrics">
        <thead><tr><th>Market</th><th>Maç</th><th>Logloss</th><th>Baseline</th>
          <th>Kazanç</th><th>İsabet</th><th>Baseline isabet</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="note">Logloss düşük olması iyidir ve olasılıkların ne kadar doğru
        olduğunu ölçer. Çıplak isabet oranı yanıltıcıdır: "her maça üst de" demek
        %53 isabet verir, bu bir başarı değildir. Bu yüzden bir market ancak
        logloss'u baseline'dan belirgin şekilde iyiyse güvenilir sayılıyor.</p>
    </section>
    <section class="card">
      <h2>Nasıl çalışıyor</h2>
      <p style="margin:0 0 .6rem">Model tek bir şey tahmin ediyor: her takımın o
        maçta atması beklenen gol sayısı. Bu iki sayıdan bir skor olasılık matrisi
        kuruluyor ve bütün marketler aynı matristen okunuyor — bu yüzden tahminler
        birbiriyle çelişemiyor.</p>
      <p style="margin:0 0 .6rem">Girdiler: Elo gücü, son 5 ve 10 maçın gol ve xG
        ortalamaları, ev/deplasman formu ve dinlenme süresi. Her maçın girdileri
        yalnızca o maç başlamadan önce biten maçlardan hesaplanıyor; bu bir testle
        zorunlu kılınıyor.</p>
      <p style="margin:0"><strong>Neden neredeyse hiç "beraberlik" yazmıyor?</strong>
        Çünkü beraberlik futbolda tek başına nadiren en olası sonuçtur: olasılığı
        pratikte %33'ü aşmazken favorininki rahatça aşar. Ölçümde 4152 maçın
        yalnızca birinde beraberlik en yüksek olasılık çıktı — ama beraberlik
        olasılıkları doğru: model ortalama %24.6 dedi, gerçekte %25.4 oldu.
        Yani model beraberliği eksik tahmin etmiyor, beraberlik sadece nadiren
        <em>kazanan</em> seçenek oluyor. Bahis oranları da aynı sebeple böyledir.</p>
    </section>`;
}

// ─── Durum ve yönlendirme ──────────────────────────────────────────────────

const state = {
  day: null, stripStart: null, week: null,
  calOpen: false, calMonth: null, calCtx: null, filterOpen: false,
};

let lastHash = null;

/* Tarayıcının kendi kaydırma geri yüklemesi kapatılıyor. Açık kaldığında
   bizim scrollTo(0,0) çağrımızdan SONRA çalışıp onu eziyor ve sayfa aşağı
   kaydırılmış açılıyordu. İçerik zaten fetch sonrası çizildiği için tarayıcı
   konumu yanlış anda geri yüklüyor.
   Konumu kendimiz saklıyoruz: yeni bir görünüm en üstten başlıyor, geri
   dönüldüğünde kaldığın yere dönüyorsun. */
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const scrollMemory = new Map();

/** Kullanıcının ana sayfada görmek istediği ligler. Boş küme "hepsi"
    demek — filtre kurulmamışken hiçbir şey gizlenmemeli. localStorage'da
    saklanıyor ki ziyaretler arasında kalsın. */
function hiddenLeagues() {
  try {
    return new Set(JSON.parse(localStorage.getItem("ballinc-hidden") || "[]"));
  } catch { return new Set(); }
}

function setHiddenLeagues(set) {
  try { localStorage.setItem("ballinc-hidden", JSON.stringify([...set])); }
  catch { /* özel pencere */ }
}

/** Filtreyi gövde seviyesindeki kabına çizer.

    `#view` içinde olamaz: sayfa geçiş animasyonu her doğrudan çocuğa kalıcı
    bir yığınlama bağlamı veriyor ve panelin z-index'i o bağlamın dışına
    çıkamıyor — maç listesi panelin üstüne biniyordu. */
function paintFilter(leagues) {
  el("filter-host").innerHTML = state.filterOpen ? filterPanelHTML(leagues) : "";
}

function filterPanelHTML(leagues) {
  const hidden = hiddenLeagues();
  // Yirmi yarışma dikey liste olarak uzun ve okunması yorucu; logoların
  // olduğu bir ızgarada hepsi tek ekranda görünüyor ve seçim tek dokunuş.
  const cell = (l) => `
    <button class="filter-cell" type="button" data-toggle-league="${esc(l.code)}"
            aria-pressed="${!hidden.has(l.code)}" title="${esc(l.name)}">
      ${leagueLogo(l.code)}
      <span class="fc-name">${esc(l.name)}</span>
      <span class="fc-count">${l.upcoming ? `${l.upcoming} maç` : "yakında"}</span>
    </button>`;
  const group = (tier, title) => {
    const found = leagues.filter((l) => (l.tier ?? 0) === tier);
    if (!found.length) return "";
    return `<div class="filter-group">${esc(title)}</div>
      <div class="filter-grid">${found.map(cell).join("")}</div>`;
  };
  const rows = group(0, "Ligler") + group(1, "Avrupa kupaları")
    + group(2, "Diğer ligler");
  // Bulanık katman panelle AYNI yığınlama bağlamında olmalı; kök seviyeye
  // koyulursa .page-head'in kendi bağlamı yüzünden panelin altında kalıyor
  // ve panelin kendisi de bulanıklaşıyor (takvimde aynı hatayı yapmıştım).
  return `<div class="filter-scrim" aria-hidden="true"></div>
    <div class="filter-panel" role="dialog" aria-label="Lig filtresi">
      <div class="filter-head">
        <span>Ligler <b>${leagues.length - hidden.size}/${leagues.length}</b></span>
        <button class="icon-btn" type="button" data-filter="close" aria-label="Kapat">✕</button>
      </div>
      <div class="filter-body">${rows}</div>
      <div class="filter-foot">
        <button class="cal-today-btn" type="button" data-league-main>Sadece ana ligler</button>
        <button class="cal-today-btn" type="button" data-league-all>Hepsini göster</button>
      </div>
    </div>`;
}

/** Maç sayfasından "geri" hangi listeye dönmeli. Kullanıcı tüm maçlardan
    geldiyse tüm maçlara, bir lig sayfasından geldiyse o lige dönmeli. */
let lastList = { href: "#/", label: "Tüm maçlar" };

/** Yalnızca takvimi yeniden çizer. Ay değiştirmek ya da takvimi açıp kapamak
    sayfanın geri kalanını ilgilendirmiyor; route() çağırmak listeyi ve bütün
    giriş animasyonlarını baştan oynatıyor, bu da sayfa yenileniyormuş gibi
    hissettiriyordu. */
function renderCalendar(direction = 0) {
  const wrap = document.querySelector(".cal-wrap");
  const ctx = state.calCtx;
  if (!wrap || !ctx) return route();

  const button = wrap.querySelector("[data-cal]");
  if (button) button.setAttribute("aria-expanded", String(state.calOpen));

  const existing = wrap.querySelector(".cal");
  document.body.classList.toggle("cal-open", state.calOpen);
  if (!state.calOpen) {
    if (existing) existing.remove();
    wrap.querySelector(".cal-scrim")?.remove();
    return;
  }

  // Ay değişiminde kutu yerinde kalıp yalnızca içeriği yenileniyor. Kutuyu
  // silip yeniden eklemek açılış animasyonunu baştan oynatıyor ve takvim
  // kapanıp açılıyormuş gibi görünüyordu.
  if (existing && direction) {
    existing.innerHTML = calendarInner(ctx.dates, ctx.selected, ctx.counts);
    const grid = existing.querySelectorAll(".cal-grid")[1];
    if (grid) {
      grid.style.setProperty("--dir", String(direction));
      grid.classList.add("cal-slide");
    }
    return;
  }

  if (existing) existing.remove();
  wrap.querySelector(".cal-scrim")?.remove();
  wrap.insertAdjacentHTML("beforeend",
    calendarHTML(ctx.dates, ctx.selected, ctx.counts));
}

async function route() {
  const view = el("view");
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  // İlk boyamada yükleniyor göster; sonrasında mevcut içerik yerinde kalsın.
  // Her gezinmede ekranı boşaltmak sayfa yenileniyormuş gibi hissettiriyordu.
  if (!view.dataset.painted) {
    view.innerHTML = '<div class="loading">Yükleniyor…</div>';
  }

  try {
    let html;
    if (parts[0] === "lig" && parts[1]) {
      html = await viewLeague(decodeURIComponent(parts[1]), parts[2]);
    } else if (parts[0] === "mac" && parts[1]) {
      html = await viewMatch(decodeURIComponent(parts[1]), parts[2]);
    } else if (parts[0] === "takim" && parts[1]) {
      html = await viewTeam(decodeURIComponent(parts[1]), parts[2]);
    } else if (parts[0] === "model") {
      html = await viewModel();
    } else {
      html = await viewHome();
    }
    view.innerHTML = html;
    view.dataset.painted = "1";
    // Filtre yalnızca ana sayfada var; başka görünüme geçilince kalıntı
    // kalmasın (kap #view dışında olduğu için kendiliğinden temizlenmiyor).
    if (parts.length) {
      state.filterOpen = false;
      el("filter-host").innerHTML = "";
    }
    document.body.classList.toggle("cal-open", state.calOpen);
    document.body.classList.toggle("filter-open", state.filterOpen);
    // Canlı yoklama her görünümde çalışıyor: puan durumu ve sonuçlar da
    // biten maçlarla tamamlanıyor, orada canlı satır olmasa bile.
    applyLive();
    startLive();
    fillMatchDetail();
    // Gerçek gezinmede sayfa başına dön. Gün/hafta seçimi gibi yerinde
    // durum değişikliklerinde kaydırma korunuyor, yoksa listede aşağıdayken
    // gün değiştirmek kullanıcıyı yukarı fırlatırdı.
    if (location.hash !== lastHash) {
      // Görünüm değişti: daha önce burada kaldığımız yer varsa oraya,
      // yoksa en üste.
      window.scrollTo(0, scrollMemory.get(location.hash) ?? 0);
      lastHash = location.hash;
    }
    scrollSelectedIntoView();
  } catch (err) {
    view.innerHTML = `<div class="empty">Veri yüklenemedi.<br>
      <span class="muted">${esc(err.message)}</span></div>`;
  }
  await paintNav();
}

/** Seçili hafta/gün şeridin görünmeyen kısmındaysa kendiliğinden ortalansın. */
function scrollSelectedIntoView() {
  const track = document.querySelector(".weeks");
  if (track) track.classList.toggle("scrollable", track.scrollWidth > track.clientWidth + 4);
  const active = document.querySelector('.weeks .week-chip[aria-pressed="true"]');
  if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
}

/* İçerik tıklamaları. Hem #view'e hem filtre kabına bağlı: filtre paneli
   yığınlama bağlamı sorunu yüzünden #view dışına taşındı ve yalnızca
   #view'e bağlı kalsaydı lig seçimi tıklamaları hiç ulaşmayacaktı. */
const onContentClick = (event) => {
  // Yalnızca takım ADINA basıldığında takım sayfasına gidiliyor. Satırın
  // kalanı maça gitmeye devam ediyor. Satır zaten bir <a> olduğu için isim
  // içine ikinci bir <a> konulamıyor (geçersiz HTML); bu yüzden tıklama
  // burada yakalanıp varsayılan gezinme iptal ediliyor.
  const teamName = event.target.closest("[data-team]");
  if (teamName) {
    event.preventDefault();
    event.stopPropagation();
    location.hash = `#/takim/${encodeURIComponent(teamName.dataset.team)}`;
    return;
  }

  const star = event.target.closest("[data-fav]");
  if (star) {
    toggleFavourite(star.dataset.fav);
    return route();
  }

  const day = event.target.closest("[data-day]");
  if (day) {
    state.day = day.dataset.day;
    // Şeritten seçildiyse şerit yerinde kalsın (tıklanan gün zaten görünür);
    // takvimden seçildiyse şerit o günün etrafına yeniden konumlansın.
    if (!day.classList.contains("day-btn")) state.stripStart = null;
    state.calOpen = false;
    state.calMonth = null;
    return route();
  }

  // Takvimle ilgili tıklamalar işaretleniyor: renderCalendar() eski takvimi
  // DOM'dan siliyor, olay document'a kabardığında `event.target` artık kopmuş
  // oluyor ve closest(".cal-wrap") null dönüyor — dışarı tıklama sanılıp
  // takvim hemen kapanıyordu.
  // Bulanık katman .cal-wrap içinde olduğu için "dışarı tıklama" sayılmıyor;
  // ayrıca ele alınması gerekiyor.
  if (event.target.classList.contains("cal-scrim")) {
    event.insideCalendar = true;
    state.calOpen = false;
    return renderCalendar();
  }

  const calToggle = event.target.closest("[data-cal]");
  if (calToggle) {
    event.insideCalendar = true;
    state.calOpen = !state.calOpen;
    if (state.calOpen) state.calMonth = null;
    return renderCalendar();
  }

  const calMonth = event.target.closest("[data-calmonth]");
  if (calMonth) {
    event.insideCalendar = true;
    const target = calMonth.dataset.calmonth;
    const current = state.calMonth ?? state.calCtx?.selected?.slice(0, 7) ?? target;
    state.calMonth = target;
    return renderCalendar(target > current ? 1 : -1);
  }

  // Katman .filter-wrap içinde olduğu için "dışarı tıklama" sayılmıyor.
  if (event.target.classList.contains("filter-scrim")) {
    event.insideFilter = true;
    state.filterOpen = false;
    return route();
  }

  const filterToggle = event.target.closest("[data-filter]");
  if (filterToggle) {
    event.insideFilter = true;
    state.filterOpen = filterToggle.dataset.filter === "close" ? false : !state.filterOpen;
    return route();
  }

  const toggleLeague = event.target.closest("[data-toggle-league]");
  if (toggleLeague) {
    event.insideFilter = true;
    const code = toggleLeague.dataset.toggleLeague;
    const set = hiddenLeagues();
    if (set.has(code)) set.delete(code); else set.add(code);
    setHiddenLeagues(set);
    state.day = null; state.stripStart = null;
    return route();
  }

  if (event.target.closest("[data-league-all]")) {
    event.insideFilter = true;
    setHiddenLeagues(new Set());
    state.day = null; state.stripStart = null;
    return route();
  }

  // Yirmi yarışma açıkken günün listesi uzun oluyor; tek dokunuşla altı ana
  // lige dönmek, hepsini tek tek kapatmaktan iyi.
  if (event.target.closest("[data-league-main]")) {
    event.insideFilter = true;
    // Tıklama işleyicisi eşzamanlı; meta zaten önbellekte ama söz veriyor.
    return getJSON("meta.json").then((meta) => {
      setHiddenLeagues(new Set(meta.leagues.filter((l) => l.tier).map((l) => l.code)));
      state.day = null; state.stripStart = null;
      return route();
    });
  }

  const strip = event.target.closest("[data-strip]");
  if (strip) {
    state.stripStart = (state.stripStart ?? 0) + Number(strip.dataset.strip) * STRIP_DAYS;
    return route();
  }

  const chip = event.target.closest(".week-chip");
  if (chip) { state.week = Number(chip.dataset.week); return route(); }

  const weekNav = event.target.closest("[data-weeknav]");
  if (weekNav) {
    const chips = [...document.querySelectorAll(".week-chip")].map((c) => Number(c.dataset.week));
    const current = chips.indexOf(state.week ?? chips[chips.length - 1]);
    const next = clamp(current + Number(weekNav.dataset.weeknav), 0, chips.length - 1);
    state.week = chips[next];
    return route();
  }
};

el("view").addEventListener("click", onContentClick);
el("filter-host").addEventListener("click", onContentClick);

// Takvim dışına tıklayınca kapansın; Esc de kapatsın.
document.addEventListener("click", (event) => {
  // Panel artık .filter-wrap içinde değil; kendisine bakılıyor.
  if (state.filterOpen && !event.insideFilter
      && !event.target.closest(".filter-panel, .filter-wrap")) {
    state.filterOpen = false;
    route();
    return;
  }
  if (!state.calOpen) return;
  if (event.insideCalendar) return;
  if (event.target.closest(".cal-wrap")) return;
  state.calOpen = false;
  renderCalendar();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.calOpen) {
    state.calOpen = false;
    renderCalendar();
  }
});

async function paintNav() {
  const meta = await getJSON("meta.json");
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const active = parts[0] === "lig" ? decodeURIComponent(parts[1]) : "";

  // Üst çubukta yalnızca ana ligler. Yirmi yarışmayı buraya dizmek çubuğu
  // kullanılamaz hale getirirdi; Avrupa kupaları ve besleyici ligler menüde
  // ve lig filtresinde.
  const others = meta.leagues.filter((l) => l.tier);
  const otherActive = others.some((l) => l.code === active);
  el("league-nav").innerHTML = meta.leagues.filter((l) => !l.tier).map((l) => {
    const current = l.code === active ? ' aria-current="page"' : "";
    // Dar ekranda yazı gizlenip yalnızca logo kalıyor; başlık nitelikleri
    // adı erişilebilir tutuyor.
    return `<a class="league-tab" href="#/lig/${encodeURIComponent(l.code)}"${current}
       title="${esc(l.name)}">${leagueLogo(l.code)}<span>${esc(l.name)}</span></a>`;
  }).join("");

  // Avrupa kupaları ve besleyici ligler üst çubuğa sığmıyor; menüyü açan bir
  // giriş, onlara ulaşmanın tek yolu şeridi kaydırmak olmasın diye.
  el("more-leagues").innerHTML = others.length
    ? `<button class="league-tab more-tab" type="button" data-more
               aria-controls="more-panel" aria-expanded="false"${
                 otherActive ? ' aria-current="page"' : ""}>
         <span class="more-dots" aria-hidden="true">⋯</span>
         <span class="more-label">Diğer ligler</span><b>${others.length}</b></button>`
    : "";

  const card = (l) => {
    const current = l.code === active ? ' aria-current="page"' : "";
    return `<a class="more-card" href="#/lig/${encodeURIComponent(l.code)}"${current}>
      ${leagueLogo(l.code)}
      <span class="mc-name">${esc(l.name)}</span>
      <span class="mc-count">${l.upcoming ? `${l.upcoming} maç` : "yakında"}</span>
    </a>`;
  };
  const section = (tier, title) => {
    const rows = others.filter((l) => l.tier === tier);
    if (!rows.length) return "";
    return `<div class="more-group">${esc(title)}</div>
      <div class="more-grid">${rows.map(card).join("")}</div>`;
  };
  el("more-panel").innerHTML = `<div class="wrap">
    ${section(1, "Avrupa kupaları")}${section(2, "Diğer ligler")}</div>`;

  const onHome = !parts.length;
  const homeItem = `<a class="drawer-item"${onHome ? ' aria-current="page"' : ""} href="#/">
      <span class="d-icon" aria-hidden="true">⚽</span><span>Tüm maçlar</span>
      <span class="d-count">${meta.leagues.reduce((n, l) => n + l.upcoming, 0)} maç</span></a>
    <div class="drawer-sep"></div>`;

  const item = (l) => {
    const current = l.code === active ? ' aria-current="page"' : "";
    const count = l.upcoming ? `${l.upcoming} maç` : "fikstür yok";
    return `<a class="drawer-item" href="#/lig/${encodeURIComponent(l.code)}"${current}>
      ${leagueLogo(l.code)}<span>${esc(l.name)}</span>
      <span class="d-count">${count}</span></a>`;
  };
  // Yirmi yarışma tek düz liste olarak okunmuyor; başlıklarla ayrılıyor.
  const group = (tier, title) => {
    const rows = meta.leagues.filter((l) => (l.tier ?? 0) === tier);
    if (!rows.length) return "";
    return `<div class="drawer-group">${esc(title)}</div>${rows.map(item).join("")}`;
  };
  el("drawer-nav").innerHTML = homeItem
    + group(0, "Ligler")
    + group(1, "Avrupa kupaları")
    + group(2, "Diğer ligler");

  goalProxy = meta.goal_proxy || "";

  el("generated-at").textContent = `Son güncelleme: ${new Date(meta.generated_at)
    .toLocaleString("tr-TR", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" })}`;
}

// ─── Canlı skorlar ─────────────────────────────────────────────────────────
/* Site statik ve gecede bir güncelleniyor; canlı skor ise dakikalık veri
   ister. Tarayıcı FotMob'a doğrudan erişebildiği için (Origin gönderildiğinde
   CORS izni veriyor) ek sunucuya, proxy'ye ya da dakikalık deploy'a gerek
   yok. Çağrı başarısız olursa hiçbir şey bozulmaz: site zaten canlı veri
   olmadan tam çalışıyor. */

const LIVE_URL = "https://www.fotmob.com/api/data/matches?date=";
/* Golcü proxy'sinin adresi meta.json'dan geliyor (pipeline/config.py ->
   GOAL_PROXY_URL). Boşsa golcü gösterimi hiç denenmiyor. */
let goalProxy = "";
const MAX_ADDED_TIME = 20;   // bundan fazlası kaynağın saymaya devam etmesi
const LIVE_IDLE = 60_000;
const LIVE_ACTIVE = 25_000;   // canlı maç varken daha sık bak
let liveTimer = null;
let liveInterval = 0;
let liveData = new Map();

/* Puan durumu ve sonuçlar sekmelerinde ekranda canlı maç satırı yok; o
   yüzden hangi günlerin çekilmesi gerektiğini görünüm ayrıca bildiriyor.
   Aksi halde canlı tamamlama o sekmelerde hiç çalışmıyordu. */
let extraLiveDays = new Set();

function noteLiveDays(matches) {
  extraLiveDays = new Set((matches ?? []).map((m) => fotmobDay(m.kickoff)));
}

/* Gol bildirimi skor değişiminden anlaşılıyor; golcü bilgisine gerek yok.
   Sayfa ilk açıldığında bildirim çıkmıyor — o an zaten var olan skoru "yeni
   gol" sanmamak için. */
const previousScores = new Map();
let firstLivePass = true;

/* Bant üç olayda birden çıkıyor. Yazı ve renk dışında hepsi aynı; olayın
   ilgili taraftan süpürmesi, hangi takımı ilgilendirdiğini tek başına
   anlatıyor. */
const FLASH_TEXT = {
  gol: "G<i>O</i>L!",
  iptal: "İPTAL",
  kirmizi: '<b class="rc"></b>KIRMIZI',
};

const previousFinished = new Map();

function detectEvents() {
  const events = [];
  for (const [key, state] of liveData) {
    const home = state.home ?? 0, away = state.away ?? 0;
    const now = `${home}-${away}`;
    const before = previousScores.get(key);
    // Maç sonu bildirim üretiyor ama bant üretmiyor: FLASH_TEXT'te karşılığı yok.
    if (!firstLivePass && previousFinished.get(key) === false && state.finished) {
      events.push({ key, kind: "bitti" });
    }
    previousFinished.set(key, !!state.finished);
    if (!firstLivePass && before !== undefined && before !== now) {
      // Hangi tarafın attığı skor farkından belli oluyor, ayrı bir veriye
      // gerek yok.
      const [bh, ba] = before.split("-").map(Number);
      if (home > bh) events.push({ key, side: "home", kind: "gol" });
      if (away > ba) events.push({ key, side: "away", kind: "gol" });
      // Skor geri gittiyse VAR golü iptal etmiş.
      if (home < bh) events.push({ key, side: "home", kind: "iptal" });
      if (away < ba) events.push({ key, side: "away", kind: "iptal" });
    }
    previousScores.set(key, now);
  }
  firstLivePass = false;
  return events;
}

/** Bant ilgili taraftan süpürüyor: ev sahibi soldan sağa, deplasman sağdan
    sola. Yön satırdaki takım sırasıyla aynı olduğu için kimin olayı olduğunu
    ayrıca yazmaya gerek kalmıyor.

    İptal tek istisna: kutlamanın geri alınması olduğu için bant golün geldiği
    yönün tersine gidiyor. */
function flashEvent(key, { kind = "gol", side = "home" } = {}) {
  const node = document.querySelector(`[data-live="${CSS.escape(key)}"]`);
  if (!node || node.querySelector(".goal-flash")) return;
  const sweep = kind === "iptal" ? (side === "home" ? "away" : "home") : side;
  const flash = document.createElement("div");
  flash.className = `goal-flash kind-${kind} from-${sweep === "away" ? "away" : "home"}`;
  flash.innerHTML = `<span>${FLASH_TEXT[kind] ?? ""}</span>`;
  node.appendChild(flash);
  // Zaman aşımı yedeği şart: hareket azaltma modunda animasyon çalışmıyor,
  // dolayısıyla animationend hiç tetiklenmiyor ve bildirim ekranda kalıyordu.
  const remove = () => flash.remove();
  // Hedef kontrolü de şart: animationend baloncuklanıyor ve "GOL!" içindeki
  // zıplama 1.5 saniyede bitiyor — bant 3.4 saniyelik süpürmesini
  // tamamlayamadan kalkıyordu.
  flash.addEventListener("animationend", (e) => { if (e.target === flash) remove(); });
  setTimeout(remove, 4000);
}

/* Golcü bilgisi ayrı bir uçta ve FotMob oraya CORS izni VERMİYOR (liste ucuna
   veriyor, matchDetails'e vermiyor — ikisi de tarayıcıdan test edildi). Yani
   canlı golcü bilgisi tarayıcıdan doğrudan alınamıyor; küçük bir proxy
   gerekiyor.

   worker/ altındaki Cloudflare Worker bu çağrıyı sunucu tarafında yapıyor ve
   yalnızca gol olaylarını döndürüyor. Adres ayarlı değilse golcü gösterimi
   sessizce atlanıyor; ilk başarısızlıkta da kendini kapatıyor ki dakikada bir
   boşuna istek atmasın. */
const goalCache = new Map();
const previousCards = new Map();
let goalsUnavailable = false;

async function fetchGoals(matchId, scoreKey) {
  if (goalsUnavailable || !goalProxy) throw new Error("golcü kaynağı yok");
  const cached = goalCache.get(matchId);
  if (cached && cached.scoreKey === scoreKey) return cached.events;

  let response;
  try {
    response = await fetch(`${goalProxy}?matchId=${encodeURIComponent(matchId)}`,
                           { cache: "no-store" });
  } catch (error) {
    goalsUnavailable = true;   // erişilemiyor: bir daha denemenin anlamı yok
    throw error;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  const goals = (payload.goals ?? []).slice().sort((a, b) => a.minute - b.minute);
  const redCards = (payload.redCards ?? []).slice().sort((a, b) => a.minute - b.minute);

  const events = { goals, redCards };
  goalCache.set(matchId, { scoreKey, events });
  return events;
}

/** Kırmızı kart rozeti. Birden fazlaysa kartın içinde sayı yazıyor. */
function redCardBadge(cards) {
  if (!cards.length) return "";
  const title = cards.map((c) => `${c.name} ${c.minute}'`).join(", ");
  const count = cards.length > 1 ? cards.length : "";
  return `<span class="redcard" title="${esc(title)}">${count}</span>`;
}

/** Canlı dakika. Uzatmada "46" yerine "45+1" gösteriliyor: FotMob ham
    dakikayı veriyor (`short`) ve devre sonunu ayrı alanda (`maxTime`).
    `addedTime` alanına güvenilmiyor — canlı maçlarda hep 0 geliyor. */
function liveMinute(state) {
  const raw = (state.minute ?? "").trim();
  if (!raw) return "canlı";
  if (raw === "HT") return "İY";      // devre arası
  if (raw === "FT") return "MS";      // maç sonu

  const minute = Number.parseInt(raw, 10);
  const end = Number(state.maxTime);
  if (Number.isFinite(minute) && Number.isFinite(end) && minute > end) {
    // Kaynak, hakem düdüğü ile `finished` bayrağı arasında saymayı
    // sürdürebiliyor; makul olmayan değerleri "90+" olarak kesiyoruz.
    const added = minute - end;
    return added > MAX_ADDED_TIME ? `${end}+` : `${end}+${added}'`;
  }
  return Number.isFinite(minute) ? `${minute}'` : raw;
}

/** "Aspas 14'" — kendi kalesine ve penaltı işaretleriyle. */
function goalLabel(goal) {
  const marks = `${goal.penalty ? " (P)" : ""}${goal.own ? " (KK)" : ""}`;
  return `${esc(goal.name)} ${goal.minute}'${marks}`;
}

async function paintGoals() {
  if (goalsUnavailable || !goalProxy) return;
  for (const node of document.querySelectorAll("[data-live]")) {
    const state = liveData.get(node.dataset.live);
    if (!state?.matchId) continue;
    if (!node.querySelector(".goals-h, .cards-h")) continue;

    let events;
    try {
      // Skor anahtarına dakika da eklendi: kırmızı kart skoru değiştirmiyor,
      // yalnızca skora bakılsaydı kart maç boyunca hiç görünmezdi.
      events = await fetchGoals(state.matchId,
        `${state.home}-${state.away}@${state.minute}`);
    } catch { continue; }

    const { goals, redCards } = events;
    const put = (selector, html) =>
      node.querySelectorAll(selector).forEach((s) => { s.innerHTML = html; });

    put(".goals-h", goals.filter((g) => g.home).map(goalLabel).join(", "));
    put(".goals-a", goals.filter((g) => !g.home).map(goalLabel).join(", "));
    const homeCards = redCards.filter((c) => c.home);
    const awayCards = redCards.filter((c) => !c.home);
    put(".cards-h", redCardBadge(homeCards));
    put(".cards-a", redCardBadge(awayCards));

    // Kart skoru değiştirmediği için canlı skordan anlaşılmıyor; sayı
    // burada, kartlar çizilirken karşılaştırılıyor. Bir maçı ilk görüşte
    // bildirim çıkmıyor: o an zaten ekranda olan kart "yeni" sayılmamalı.
    const key = node.dataset.live;
    const seenCards = previousCards.get(key);
    const nowCards = `${homeCards.length}-${awayCards.length}`;
    if (seenCards !== undefined && seenCards !== nowCards) {
      const [ph, pa] = seenCards.split("-").map(Number);
      const side = homeCards.length > ph ? "home"
        : awayCards.length > pa ? "away" : null;
      if (side) {
        flashEvent(key, { kind: "kirmizi", side });
        notifyEvents([{ key, kind: "kirmizi", side }]);
      }
    }
    previousCards.set(key, nowCards);
  }
}

/** Maçı canlı veriyle eşleştiren anahtar. İsimle değil kimlikle eşleşiyor. */
function liveKey(match) {
  const h = match.home?.fm, a = match.away?.fm;
  return h && a ? `${h}|${a}` : null;
}

/** FotMob maçları UTC gününe göre grupluyor; kick-off zaten UTC. */
const fotmobDay = (iso) => iso.slice(0, 10).replaceAll("-", "");

/** Hangi günleri çekmeliyiz: ekrandaki maçların kendi günleri.
    Yalnızca "bugün"ü çekmek gece yarısından sonra devam eden maçları
    kaybettiriyordu — İstanbul günü ilerliyor ama maç hâlâ önceki UTC
    gününde listeleniyor, satır canlı veri bulamayıp başlama saatine
    dönüyordu. */
function liveDays() {
  // Nitelik adı bilerek `data-fmday`: `data-day` tarih şeridi düğmelerinde
  // kullanılıyor ve orada tarih tireli biçimde duruyor. Aynı adı paylaşınca
  // şeridin günleri de çekilmeye çalışılıyor, canlı veri hiç gelmiyordu.
  const days = new Set();
  for (const node of document.querySelectorAll("[data-fmday]")) {
    if (node.dataset.fmday) days.add(node.dataset.fmday);
  }
  if (!days.size) days.add(todayKey().replaceAll("-", ""));
  return [...days].slice(0, 3);   // makul üst sınır
}

async function fetchLive() {
  const payloads = await Promise.all(
    liveDays().map((day) =>
      fetch(LIVE_URL + day, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)),
  );
  if (payloads.every((p) => !p)) throw new Error("canlı veri alınamadı");

  const map = new Map();
  for (const payload of payloads.filter(Boolean)) {
  for (const league of payload.leagues ?? []) {
    for (const match of league.matches ?? []) {
      const status = match.status ?? {};
      if (!status.started) continue;
      map.set(`${match.home?.id}|${match.away?.id}`, {
        matchId: match.id,
        home: match.home?.score,
        away: match.away?.score,
        // Bildirim metni icin: sayfada olmayan bir mac icin de ad gerekiyor.
        homeName: match.home?.name,
        awayName: match.away?.name,
        // FotMob dakikayı görünmez yön işaretleri ve kesme işaretiyle
        // gönderiyor ("92‎’‎"); ham sayıyı saklayıp biçimi biz veriyoruz.
        minute: (status.liveTime?.short ?? "")
          .replace(/[‎‏’'’]/g, "").trim(),
        // Devrenin bitiş dakikası: ilk yarıda 45, ikincide 90.
        maxTime: status.liveTime?.maxTime,
        finished: !!status.finished,
        ongoing: !!status.ongoing,
      });
    }
  }
  }
  liveData = map;
}

function applyLive() {
  revealCarry();
  for (const node of document.querySelectorAll("[data-live]")) {
    const state = liveData.get(node.dataset.live);
    const clock = node.querySelector(".clock");
    const home = node.querySelector(".live-h");
    const away = node.querySelector(".live-a");
    if (!state || !clock) continue;

    if (home) home.textContent = state.home ?? "";
    if (away) away.textContent = state.away ?? "";
    node.classList.toggle("is-live", state.ongoing);
    node.classList.toggle("is-done", state.finished);

    if (state.ongoing) {
      clock.innerHTML = `<span class="live-dot"></span>${esc(liveMinute(state))}`;
    } else if (state.finished) {
      clock.textContent = "BİTTİ";
    }
  }
}

/** Önceki günden devam eden maçlardan yalnızca gerçekten oynananları açar. */
function revealCarry() {
  const section = document.querySelector(".carry");
  if (!section) return;
  let visible = 0;
  for (const row of section.querySelectorAll("[data-live]")) {
    const state = liveData.get(row.dataset.live);
    const live = !!state?.ongoing;
    row.hidden = !live;
    if (live) visible += 1;
  }
  section.hidden = visible === 0;
}

/** Biten maçların imzası. Değiştiğinde puan durumu ve sonuçlar yeniden
    çizilmeli, yoksa canlı tamamlama ilk yüklemede boş kalıyor. */
function finishedSignature() {
  return [...liveData.entries()]
    .filter(([, s]) => s.finished)
    .map(([k, s]) => `${k}:${s.home}-${s.away}`)
    .sort().join("|");
}

// Boş dize ile başlıyor, null ile değil: ilk çizim canlı veri gelmeden
// yapıldığı için ilk yoklamanın da yeniden çizimi tetiklemesi gerekiyor.
// null olsaydı puan durumu ilk yüklemede tamamlanmadan kalıyordu.
let lastFinishedSig = "";

async function refreshLive() {
  if (document.hidden) return;
  try {
    await fetchLive();
    const events = detectEvents();
    applyLive();
    events.filter((e) => FLASH_TEXT[e.kind]).forEach((e) => flashEvent(e.key, e));
    notifyEvents(events);
    await paintGoals();
    retimeLive();

    const sig = finishedSignature();
    if (sig !== lastFinishedSig) {
      // Yalnızca tabloyu etkileyen görünümlerde; maç listesi zaten
      // applyLive() ile yerinde güncelleniyor.
      const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
      // Maç listeleri de etkileniyor: biten maç tahmin satırından sonuç
      // satırına dönüyor. Maç sayfası hariç — orada skor zaten applyLive()
      // ile yerinde güncelleniyor, yeniden çizmek akışı boşuna yeniden
      // yükletirdi.
      const affected = parts[0] !== "mac" && parts[0] !== "model";
      if (affected) route();
    }
    lastFinishedSig = sig;
  } catch {
    /* canlı veri isteğe bağlı; sessizce geç */
  }
}

/** Canlı maç varken daha sık, yokken daha seyrek yoklama. */
function retimeLive() {
  const anyLive = [...liveData.values()].some((s) => s.ongoing);
  const wanted = anyLive ? LIVE_ACTIVE : LIVE_IDLE;
  if (wanted === liveInterval) return;
  liveInterval = wanted;
  clearInterval(liveTimer);
  liveTimer = setInterval(refreshLive, wanted);
}

function startLive() {
  if (liveTimer) return;
  liveInterval = LIVE_IDLE;
  liveTimer = setInterval(refreshLive, liveInterval);
  refreshLive();
}

// Sekme arka plandayken boşuna istek atma.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshLive();
});

// ─── Tema ──────────────────────────────────────────────────────────────────

const THEMES = ["auto", "light", "dark"];

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("ballinc-theme", theme); } catch { /* özel pencere */ }
}

(function initTheme() {
  let stored = "auto";
  try { stored = localStorage.getItem("ballinc-theme") ?? "auto"; } catch { /* yok say */ }
  applyTheme(THEMES.includes(stored) ? stored : "auto");

  el("theme-toggle").addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % THEMES.length];
    applyTheme(next);
  });
})();

// ─── Bildirimler ───────────────────────────────────────────────────────────

/* Yalnızca favori takımların maçları için. Altı ligin bütün gollerini
   bildirmek siteyi kullanılmaz yapardı; favori zaten "beni bu ilgilendiriyor"
   demenin yolu.

   Sunucu yok, dolayısıyla gerçek push da yok: bildirim ancak site bir sekmede
   açıkken çıkıyor. Kapalıyken bildirim göndermek servis çalışanı ve push
   sunucusu gerektirirdi — bu sitenin tamamen statik olması pahasına. */

const NOTIFY_KEY = "ballinc-notify";

function notifyOn() {
  try { return localStorage.getItem(NOTIFY_KEY) === "1"; } catch { return false; }
}

function setNotifyOn(on) {
  try { localStorage.setItem(NOTIFY_KEY, on ? "1" : "0"); } catch { /* özel pencere */ }
  syncNotifyButton();
}

function syncNotifyButton() {
  const btn = document.getElementById("notify-toggle");
  if (!btn) return;
  const on = notifyOn() && window.Notification?.permission === "granted";
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.setAttribute("title", on
    ? "Favori takım bildirimleri açık"
    : "Favori takım bildirimleri kapalı");
}

/** Kısa bilgi çubuğu. Bildirim izni gibi sessizce başarısız olabilen
    işlemlerde kullanıcı ne olduğunu görebilmeli. */
function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.setAttribute("role", "status");
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

async function toggleNotify() {
  if (!("Notification" in window)) {
    toast("Tarayıcın bildirimleri desteklemiyor.");
    return;
  }
  if (notifyOn()) { setNotifyOn(false); toast("Bildirimler kapatıldı."); return; }

  let permission = Notification.permission;
  // İzin isteği kullanıcı hareketi gerektiriyor; bu yüzden burada, tıklamada.
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast("Bildirim izni verilmedi. Tarayıcı ayarlarından açabilirsin.");
    syncNotifyButton();
    return;
  }
  setNotifyOn(true);
  const count = favourites().size;
  toast(count
    ? `Bildirimler açık · ${count} favori takım`
    : "Bildirimler açık. Henüz favori takımın yok — aramadan yıldıza dokun.");
}

/** FotMob kimliği → bizim takım kimliğimiz. Canlı veri FotMob kimliğiyle
    geliyor, favoriler bizim kimliğimizle saklanıyor. */
let fmIndex = null;
async function fmToTeam() {
  if (fmIndex) return fmIndex;
  fmIndex = new Map();
  for (const t of await loadTeams()) if (t.fm) fmIndex.set(String(t.fm), t.id);
  return fmIndex;
}

const NOTIFY_TEXT = {
  gol: (h, a, hg, ag) => [`⚽ ${h} ${hg} - ${ag} ${a}`, "Gol!"],
  iptal: (h, a, hg, ag) => [`${h} ${hg} - ${ag} ${a}`, "VAR: gol iptal edildi"],
  kirmizi: (h, a, hg, ag) => [`${h} ${hg} - ${ag} ${a}`, "Kırmızı kart"],
  bitti: (h, a, hg, ag) => [`Maç sonu · ${h} ${hg} - ${ag} ${a}`, ""],
};

async function notifyEvents(events) {
  if (!events.length || !notifyOn()) return;
  if (window.Notification?.permission !== "granted") return;

  const favs = favourites();
  if (!favs.size) return;
  const index = await fmToTeam();

  for (const event of events) {
    const state = liveData.get(event.key);
    if (!state) continue;
    const mine = event.key.split("|").some((fm) => favs.has(index.get(fm)));
    if (!mine) continue;

    const build = NOTIFY_TEXT[event.kind];
    if (!build) continue;
    const [title, body] = build(state.homeName ?? "Ev", state.awayName ?? "Deplasman",
                                state.home ?? 0, state.away ?? 0);
    try {
      // tag maç başına: aynı maçın yeni bildirimi eskisinin yerini alıyor,
      // bildirim merkezi tek maçtan on tane bildirimle dolmuyor.
      new Notification(title, { body, tag: event.key, icon: "assets/logo.png" });
    } catch { /* bazı tarayıcılar yalnızca servis çalışanından izin veriyor */ }
  }
}

// ─── Takım arama ve favoriler ──────────────────────────────────────────────

/* Favoriler localStorage'da: sunucu yok, kullanıcı hesabı yok. Favori takımın
   maçı, maç günü listenin en üstüne sabitleniyor. */

function favourites() {
  try { return new Set(JSON.parse(localStorage.getItem("ballinc-fav") || "[]")); }
  catch { return new Set(); }
}

function setFavourites(set) {
  try { localStorage.setItem("ballinc-fav", JSON.stringify([...set])); }
  catch { /* özel pencere */ }
}

function toggleFavourite(id) {
  const set = favourites();
  if (set.has(id)) set.delete(id); else set.add(id);
  setFavourites(set);
  return set;
}

/** Türkçe arama: aksan ve büyük/küçük harf farkı aranan sonucu kaçırmasın
    ("besiktas" da "Beşiktaş"ı bulsun). */
function foldTr(text) {
  return String(text)
    .toLocaleLowerCase("tr")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c");
}

let teamIndex = null;

async function loadTeams() {
  if (teamIndex) return teamIndex;
  const data = await getJSON("teams.json");
  teamIndex = data.teams ?? [];
  return teamIndex;
}

async function renderSearch(query = "") {
  const teams = await loadTeams();
  const meta = await getJSON("meta.json");
  const names = Object.fromEntries(meta.leagues.map((l) => [l.code, l.name]));
  const favs = favourites();
  const needle = foldTr(query.trim());

  // Sorgu yokken favoriler gösteriliyor: arama kutusu aynı zamanda favori
  // yönetim ekranı oluyor, ayrı bir sayfaya gerek kalmıyor.
  const list = needle
    ? teams.filter((t) =>
        foldTr(t.name).includes(needle)
        || foldTr([].concat(t.alt ?? []).join(" ")).includes(needle))
    : teams.filter((t) => favs.has(t.id));

  const box = el("search-results");
  if (!list.length) {
    box.innerHTML = `<p class="search-empty">${needle
      ? "Takım bulunamadı."
      : "Henüz favori takımın yok. Aramaya başla ve yıldıza dokun."}</p>`;
    return;
  }

  box.innerHTML = list.slice(0, 40).map((t) => `
    <div class="search-row">
      <a class="search-team" href="#/takim/${encodeURIComponent(t.id)}">
        ${crest(t.id)}<span>${esc(t.name)}</span>
        <span class="search-league">${esc(names[t.league] ?? t.league)}</span>
      </a>
      <button class="star" type="button" data-fav="${esc(t.id)}"
              aria-pressed="${favs.has(t.id)}"
              aria-label="${favs.has(t.id) ? "Favorilerden çıkar" : "Favorilere ekle"}">★</button>
    </div>`).join("");
}

function setSearch(open) {
  el("search").hidden = !open;
  el("search-scrim").hidden = !open;
  el("search-btn").setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("search-open", open);
  if (open) {
    renderSearch(el("search-input").value);
    el("search-input").focus();
  }
}

el("search-btn").addEventListener("click", () => setSearch(el("search").hidden));
el("notify-toggle").addEventListener("click", toggleNotify);
syncNotifyButton();
el("search-close").addEventListener("click", () => setSearch(false));
el("search-scrim").addEventListener("click", () => setSearch(false));
el("search-input").addEventListener("input", (e) => renderSearch(e.target.value));
el("search").addEventListener("click", (event) => {
  const star = event.target.closest("[data-fav]");
  if (star) {
    toggleFavourite(star.dataset.fav);
    renderSearch(el("search-input").value);
    route();          // favori listesi değişti, sabitlenen maçlar yenilensin
    return;
  }
  if (event.target.closest(".search-team")) setSearch(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("search").hidden) setSearch(false);
});

// ─── Mobil çekmece ─────────────────────────────────────────────────────────

function setDrawer(open) {
  const drawer = el("drawer");
  drawer.hidden = !open;
  el("scrim").hidden = !open;
  el("menu-btn").setAttribute("aria-expanded", String(open));
  // Çekmece açıkken arka planın kaymasını engelle.
  document.body.style.overflow = open ? "hidden" : "";
  // Menü gizlenirken kaydırma konumu üzerinde kalıyor; içerik yeniden
  // çizilse bile eleman aynı olduğu için ikinci açılışta aşağıda
  // başlıyordu. Her açılışta en üstten.
  if (open) drawer.scrollTop = 0;
}

el("menu-btn").addEventListener("click", () => setDrawer(el("drawer").hidden));
/* "Diğer ligler" paneli üst çubuğun altından iniyor. Sol menü de aynı
   yarışmaları taşıyor ama o mobil için; geniş ekranda yandan açılan bir
   çekmece yerine üstten inen panel daha yerinde. */
function setMorePanel(open) {
  const panel = el("more-panel");
  const scrim = el("more-scrim");
  panel.hidden = !open;
  scrim.hidden = !open;
  document.querySelector("[data-more]")?.setAttribute("aria-expanded", String(open));
  if (open) panel.scrollTop = 0;
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-more]")) {
    setMorePanel(el("more-panel").hidden);
    return;
  }
  // Panelin içindeki bir yarışmaya gidilince kapanıyor; dışarı tıklamak da
  // kapatıyor.
  if (e.target.closest("#more-panel a") || !e.target.closest("#more-panel")) {
    if (!el("more-panel").hidden) setMorePanel(false);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("more-panel").hidden) setMorePanel(false);
});
el("drawer-close").addEventListener("click", () => setDrawer(false));
el("scrim").addEventListener("click", () => setDrawer(false));
el("drawer").addEventListener("click", (e) => {
  if (e.target.closest(".drawer-item")) setDrawer(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("drawer").hidden) setDrawer(false);
});

/* Marka ve "Tüm maçlar" bağlantıları "en başa dön" demek, "kaldığın yere
   dön" değil. Kaydırma hafızası geri tuşu için var; oradan gelen kullanıcı
   bıraktığı yeri bulmalı, ama ana sayfaya bilerek dönen en üstten
   başlamalı.

   İki durum da ele alınıyor: başka bir sayfadan gelince route() hafızadaki
   konuma atlıyordu (kayıt siliniyor), zaten ana sayfadayken ise hash
   değişmediği için hiçbir şey olmuyordu (elle yukarı kaydırılıyor). */
document.addEventListener("click", (event) => {
  const home = event.target.closest('a[href="#/"]');
  if (!home) return;
  scrollMemory.delete("#/");
  scrollMemory.delete("");
  window.scrollTo({ top: 0, behavior: "auto" });
});

window.addEventListener("hashchange", (event) => {
  // Ayrıldığımız görünümün konumu saklanıyor.
  const from = new URL(event.oldURL).hash;
  scrollMemory.set(from, window.scrollY);
  setDrawer(false);
  state.day = null; state.stripStart = null; state.week = null;
  state.calOpen = false; state.calMonth = null;
  route();
});
route();
