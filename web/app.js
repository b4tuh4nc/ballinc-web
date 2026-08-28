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

function oddsCells(match) {
  const p = match.markets.result;
  const best = p.indexOf(Math.max(...p));
  const labels = ["1", "X", "2"];
  return `<div class="odds">${p.map((v, i) => `
    <div class="odds-cell${i === best ? " best" : ""}">
      <span>${labels[i]}</span><b>%${pct(v)}</b>
    </div>`).join("")}</div>`;
}

function extraChips(match) {
  const ou = match.markets.over_2_5, bt = match.markets.btts;
  if (!ou || !bt) return "";
  const over = ou[1] >= ou[0], yes = bt[1] >= bt[0];
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

function resultRow(result, index = 0) {
  const [hg, ag] = result.score;
  return `
    <div class="match" style="--i:${index}">
      <div class="match-time">${timeIn(result.kickoff)}</div>
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
        ${forecastChip(result)}
        ${result.xg ? `<span class="extra-chip">xG <b>${result.xg[0]} - ${result.xg[1]}</b></span>` : ""}
      </div>
      <div class="chev"></div>
    </div>`;
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

function matchListHTML(matches) {
  if (!matches.length) return `<div class="empty">Bu pencerede oynanacak maç yok.</div>`;
  return groupByDay(matches).map(([, list]) => `
    <div class="date-head">${esc(dayLabel(list[0].kickoff))}</div>
    <div class="match-list">${list.map(matchRow).join("")}</div>
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
  const active = meta.leagues.filter((l) => l.upcoming > 0);
  const all = [];
  for (const league of active) {
    if (hidden.has(league.code)) continue;
    const data = await getJSON(`${league.code}.json`);
    all.push(...data.matches);
  }
  noteLiveDays(all);
  all.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const shown = active.length - active.filter((l) => hidden.has(l.code)).length;

  const idle = meta.leagues.filter((l) => l.upcoming === 0);
  const idleNote = idle.length ? `
    <p class="note">${idle.map((l) => esc(l.name)).join(", ")} için bu sezon
      fikstür verisi henüz yok. Yayınlandığında otomatik olarak listeye girecek.</p>` : "";

  lastList = { href: "#/", label: "Tüm maçlar" };

  const head = `
    <div class="page-head${state.filterOpen ? " filter-open" : ""}">
      <div class="page-title"><h1>Yaklaşan maçlar</h1></div>
      <p class="sub">Önümüzdeki ${meta.window_days} günün maçları · ${all.length} tahmin ·
        <a href="#/model">model ne kadar isabetli?</a></p>
      <div class="filter-wrap">
        <button class="filter-btn" type="button" data-filter="toggle"
                aria-expanded="${state.filterOpen}">
          <span class="f-icon" aria-hidden="true">⚙</span>
          Ligler <b>${shown}/${active.length}</b>
        </button>
        ${state.filterOpen ? filterPanelHTML(active) : ""}
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
  const carry = all.filter((m) => dayKey(m.kickoff) === previous && liveKey(m));
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
    <div class="match-list">${pinned.map(matchRow).join("")}</div>` : "";

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
      <div class="match-list">${matches.map(matchRow).join("")}</div>`).join("");

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
  else body = matchListHTML(data.matches);

  const lgResult = data.metrics?.result;
  const measured = lgResult
    ? ` Geriye dönük ölçümde bu ligde 1X2 tahminleri baseline'dan
        %${(lgResult.skill * 100).toFixed(1)} daha iyi (${lgResult.n} maç).` : "";
  const xgNote = data.has_xg === false ? `
    <p class="note">Bu lig için xG verisi bulunmuyor; tahminler yalnızca gol,
      form ve Elo verisine dayanıyor.${measured}</p>` : "";

  return `
    <div class="page-head">
      <div class="page-title">${leagueLogo(code)}<h1>${esc(data.name)}</h1></div>
      <p class="sub">${esc(data.season)} sezonu · ${data.matches.length} yaklaşan maç ·
        ${data.results.length} oynanmış</p>
      <nav class="tabs">${tabs}</nav>
    </div>
    ${xgNote}
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

/** Puan durumuna, statik veriye girmemiş biten maçları uygular. */
function standingsWithFresh(data) {
  const fresh = freshResults(data);
  if (!fresh.length) return { rows: data.standings, added: 0 };

  const rows = new Map(data.standings.map((r) => [r.team_id, { ...r, form: [...r.form] }]));
  const blank = (team) => ({
    team_id: team.id, team: team.name, short: team.short ?? null,
    played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, points: 0,
    xgf: null, xga: null, form: [],
  });

  for (const match of fresh) {
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
  return { rows: table, added: fresh.length };
}

function standingsHTML(data, highlight = null) {
  const { rows: table, added } = standingsWithFresh(data);
  if (!table.length) return `<div class="empty">Bu sezon henüz maç oynanmadı.</div>`;
  const hasXG = table.some((r) => r.xgf !== null);
  const note = added
    ? `<p class="muted" style="margin:.6rem 0 0;font-size:.78rem">
         ${added} yeni biten maç canlı skorlardan eklendi; xG değerleri bir
         sonraki güncellemede gelecek.</p>` : "";
  const rows = table.map((r) => `
    <tr${r.team_id === highlight ? ' class="me"' : ""}>
      <td class="rank">${r.rank}</td>
      <td><span class="team-cell" data-team="${esc(r.team_id)}">${crest(r.team_id)}${esc(r.team)}</span></td>
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

async function viewMatch(id) {
  const meta = await getJSON("meta.json");
  let match = null, data = null;
  for (const league of meta.leagues) {
    if (!league.upcoming) continue;
    const candidate = await getJSON(`${league.code}.json`);
    const found = candidate.matches.find((m) => m.id === id);
    if (found) { match = found; data = candidate; break; }
  }
  if (!match) {
    return `<a class="back" href="#/"><span class="arrow">←</span>Maçlar</a>
      <div class="empty">Bu maç artık tahmin listesinde değil. Oynanmış olabilir.</div>`;
  }

  const standing = Object.fromEntries(data.standings.map((r) => [r.team_id, r]));
  const [lh, la] = match.lambdas;
  const [ph, pd, pa] = match.markets.result;
  const top = match.top_scores[0];
  const rest = match.top_scores.slice(1, 5);

  const tbd = match.time_confirmed === false
    ? `<p class="note">Başlama saati henüz kesinleşmedi, değişebilir.</p>` : "";

  // Beraberlik futbolda neredeyse hiçbir zaman TEK BAŞINA en olası sonuç
  // olmuyor: olasılığı ~%33'ü aşmazken favori rahatça aşıyor. Ölçümde
  // 4152 maçın yalnızca 1'inde beraberlik en yüksek çıktı. Sadece en
  // yükseği vurgulamak "model hiç beraberlik demiyor" izlenimi veriyordu.
  const topProb = Math.max(ph, pd, pa);
  const balanced = topProb - pd <= 0.08;
  const drawNote = balanced
    ? `<p class="note">Dengeli maç: beraberlik ihtimali (%${pct(pd)}) en olası
        sonuca çok yakın. Beraberlik futbolda nadiren tek başına en yüksek
        olasılıktır — bu yüzden yukarıda vurgulanmasa da göz ardı edilmemeli.</p>`
    : "";
  const week = match.round ? ` · ${match.round}. Hafta` : "";
  const info = reliability(meta.metrics, "result");

  return `
    ${backLink(data)}

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
    </div>
    ${tbd}${drawNote}

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
  const fixtureHTML = fixtures.length ? `
    <div class="date-head">Sezonun kalanı · ${fixtures.length} maç</div>
    <div class="match-list">${fixtures.map(fixtureRow).join("")}</div>` : "";

  // Puan tablosu takım sayfasında da var: takımın ligde nerede olduğunu
  // görmek için başka sayfaya gitmek gerekmesin. Takımın satırı vurgulu.
  const tableHTML = standingsHTML(data, id);

  const playedHTML = played.length
    ? groupByDay(played).reverse().map(([, day]) => `
        <div class="date-head">${esc(dayLabel(day[0].kickoff))}</div>
        <div class="match-list">${day.map(resultRow).join("")}</div>`).join("")
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
        ? (fixtureHTML || `<div class="empty">Kalan fikstür yok.</div>`)
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

function filterPanelHTML(leagues) {
  const hidden = hiddenLeagues();
  const rows = leagues.map((l) => `
    <button class="filter-row" type="button" data-toggle-league="${esc(l.code)}"
            aria-pressed="${!hidden.has(l.code)}">
      ${leagueLogo(l.code)}<span>${esc(l.name)}</span>
      <span class="tick" aria-hidden="true">✓</span>
    </button>`).join("");
  // Bulanık katman panelle AYNI yığınlama bağlamında olmalı; kök seviyeye
  // koyulursa .page-head'in kendi bağlamı yüzünden panelin altında kalıyor
  // ve panelin kendisi de bulanıklaşıyor (takvimde aynı hatayı yapmıştım).
  return `<div class="filter-scrim" aria-hidden="true"></div>
    <div class="filter-panel" role="dialog" aria-label="Lig filtresi">
      <div class="filter-head">
        <span>Ligler</span>
        <button class="icon-btn" type="button" data-filter="close" aria-label="Kapat">✕</button>
      </div>
      ${rows}
      <div class="filter-foot">
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
      html = await viewMatch(decodeURIComponent(parts[1]));
    } else if (parts[0] === "takim" && parts[1]) {
      html = await viewTeam(decodeURIComponent(parts[1]), parts[2]);
    } else if (parts[0] === "model") {
      html = await viewModel();
    } else {
      html = await viewHome();
    }
    view.innerHTML = html;
    view.dataset.painted = "1";
    document.body.classList.toggle("cal-open", state.calOpen);
    document.body.classList.toggle("filter-open", state.filterOpen);
    // Canlı yoklama her görünümde çalışıyor: puan durumu ve sonuçlar da
    // biten maçlarla tamamlanıyor, orada canlı satır olmasa bile.
    applyLive();
    startLive();
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

el("view").addEventListener("click", (event) => {
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
});

// Takvim dışına tıklayınca kapansın; Esc de kapatsın.
document.addEventListener("click", (event) => {
  if (state.filterOpen && !event.insideFilter && !event.target.closest(".filter-wrap")) {
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

  el("league-nav").innerHTML = meta.leagues.map((l) => {
    const current = l.code === active ? ' aria-current="page"' : "";
    return `<a class="league-tab" href="#/lig/${encodeURIComponent(l.code)}"${current}>
      ${leagueLogo(l.code)}<span>${esc(l.name)}</span></a>`;
  }).join("");

  const onHome = !parts.length;
  const homeItem = `<a class="drawer-item"${onHome ? ' aria-current="page"' : ""} href="#/">
      <span class="d-icon" aria-hidden="true">⚽</span><span>Tüm maçlar</span>
      <span class="d-count">${meta.leagues.reduce((n, l) => n + l.upcoming, 0)} maç</span></a>
    <div class="drawer-sep"></div>`;

  el("drawer-nav").innerHTML = homeItem + meta.leagues.map((l) => {
    const current = l.code === active ? ' aria-current="page"' : "";
    const count = l.upcoming ? `${l.upcoming} maç` : "fikstür yok";
    return `<a class="drawer-item" href="#/lig/${encodeURIComponent(l.code)}"${current}>
      ${leagueLogo(l.code)}<span>${esc(l.name)}</span>
      <span class="d-count">${count}</span></a>`;
  }).join("");

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

function detectGoals() {
  const scored = [];
  for (const [key, state] of liveData) {
    const now = `${state.home ?? 0}-${state.away ?? 0}`;
    const before = previousScores.get(key);
    if (!firstLivePass && before !== undefined && before !== now) {
      // Skor geri gidebilir (VAR iptali); yalnızca artışta kutlama.
      // Hangi tarafın attığı skor farkından belli oluyor, ayrı bir veriye
      // gerek yok.
      const [bh, ba] = before.split("-").map(Number);
      if ((state.home ?? 0) > bh) scored.push({ key, side: "home" });
      if ((state.away ?? 0) > ba) scored.push({ key, side: "away" });
    }
    previousScores.set(key, now);
  }
  firstLivePass = false;
  return scored;
}

/** Bant golü atan taraftan süpürüyor: ev sahibi soldan sağa, deplasman
    sağdan sola. Yön, satırdaki takım sırasıyla aynı olduğu için kimin
    attığı bakmadan anlaşılıyor. */
function flashGoal(key, side = "home") {
  const node = document.querySelector(`[data-live="${CSS.escape(key)}"]`);
  if (!node || node.querySelector(".goal-flash")) return;
  const flash = document.createElement("div");
  flash.className = `goal-flash from-${side === "away" ? "away" : "home"}`;
  flash.innerHTML = '<span>G<i>O</i>L!</span>';
  node.appendChild(flash);
  // Zaman aşımı yedeği şart: hareket azaltma modunda animasyon çalışmıyor,
  // dolayısıyla animationend hiç tetiklenmiyor ve bildirim ekranda kalıyordu.
  const remove = () => flash.remove();
  flash.addEventListener("animationend", remove, { once: true });
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
    put(".cards-h", redCardBadge(redCards.filter((c) => c.home)));
    put(".cards-a", redCardBadge(redCards.filter((c) => !c.home)));
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
    const scored = detectGoals();
    applyLive();
    scored.forEach((g) => flashGoal(g.key, g.side));
    await paintGoals();
    retimeLive();

    const sig = finishedSignature();
    if (sig !== lastFinishedSig) {
      // Yalnızca tabloyu etkileyen görünümlerde; maç listesi zaten
      // applyLive() ile yerinde güncelleniyor.
      const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
      const affected = (parts[0] === "lig" && (parts[2] === "puan" || parts[2] === "sonuclar"))
        || parts[0] === "takim";
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
        foldTr(t.name).includes(needle) || foldTr(t.alt ?? "").includes(needle))
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
  el("drawer").hidden = !open;
  el("scrim").hidden = !open;
  el("menu-btn").setAttribute("aria-expanded", String(open));
  // Çekmece açıkken arka planın kaymasını engelle.
  document.body.style.overflow = open ? "hidden" : "";
}

el("menu-btn").addEventListener("click", () => setDrawer(el("drawer").hidden));
el("drawer-close").addEventListener("click", () => setDrawer(false));
el("scrim").addEventListener("click", () => setDrawer(false));
el("drawer").addEventListener("click", (e) => {
  if (e.target.closest(".drawer-item")) setDrawer(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("drawer").hidden) setDrawer(false);
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
