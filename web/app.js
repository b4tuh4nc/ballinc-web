/* Ballinc — statik ön yüz.
   Sunucu yok: pipeline'ın ürettiği data/*.json dosyalarını okuyup render eder.
   Yönlendirme hash tabanlı, böylece GitHub Pages'te ek ayar gerekmiyor. */

const TZ = "Europe/Istanbul";
const cache = new Map();
const DOW = ["PAZ", "PTS", "SAL", "ÇAR", "PER", "CUM", "CTS"];
const STRIP_DAYS = 7;

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

function matchRow(match) {
  const tbd = match.time_confirmed === false ? '<span class="tbd">saat?</span>' : "";
  return `
    <a class="match" href="#/mac/${encodeURIComponent(match.id)}">
      <div class="match-time">${timeIn(match.kickoff)}${tbd}</div>
      <div class="match-teams">
        <div class="team-line">${crest(match.home.id)}<span class="team-name">${esc(match.home.name)}</span></div>
        <div class="team-line">${crest(match.away.id)}<span class="team-name">${esc(match.away.name)}</span></div>
      </div>
      <div class="match-markets">${oddsCells(match)}${extraChips(match)}</div>
      <div class="chev" aria-hidden="true">›</div>
    </a>`;
}

function resultRow(result) {
  const [hg, ag] = result.score;
  return `
    <div class="match">
      <div class="match-time">${timeIn(result.kickoff)}</div>
      <div class="match-teams">
        <div class="team-line${hg < ag ? " dim" : ""}">
          ${crest(result.home.id)}<span class="team-name">${esc(result.home.name)}</span>
          <span class="team-score">${hg}</span>
        </div>
        <div class="team-line${ag < hg ? " dim" : ""}">
          ${crest(result.away.id)}<span class="team-name">${esc(result.away.name)}</span>
          <span class="team-score">${ag}</span>
        </div>
      </div>
      <div class="match-markets">
        ${result.xg ? `<div class="extra"><span class="extra-chip">xG <b>${result.xg[0]} - ${result.xg[1]}</b></span></div>` : ""}
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
      <span class="strip-nav strip-date" title="Tarih seç">📅
        <input type="date" id="jump-date" value="${selected}"
               min="${dates[0]}" max="${dates[dates.length - 1]}" aria-label="Tarihe git">
      </span>
    </div>`;
}

// ─── Görünümler ────────────────────────────────────────────────────────────

async function viewHome() {
  const meta = await getJSON("meta.json");
  const all = [];
  for (const league of meta.leagues.filter((l) => l.upcoming > 0)) {
    const data = await getJSON(`${league.code}.json`);
    all.push(...data.matches);
  }
  all.sort((a, b) => a.kickoff.localeCompare(b.kickoff));

  const idle = meta.leagues.filter((l) => l.upcoming === 0);
  const idleNote = idle.length ? `
    <p class="note">${idle.map((l) => esc(l.name)).join(", ")} için bu sezon
      fikstür verisi henüz yok. Yayınlandığında otomatik olarak listeye girecek.</p>` : "";

  const head = `
    <div class="page-head">
      <div class="page-title"><h1>Yaklaşan maçlar</h1></div>
      <p class="sub">Önümüzdeki ${meta.window_days} günün maçları · ${all.length} tahmin ·
        <a href="#/model">model ne kadar isabetli?</a></p>
    </div>`;

  if (!all.length) return `${head}${idleNote}<div class="empty">Yaklaşan maç yok.</div>`;

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

  const list = all.filter((m) => dayKey(m.kickoff) === selected);
  return `
    ${head}
    ${idleNote}
    ${dateStripHTML(dates, selected, start, counts)}
    <div class="date-head">${esc(dayLabel(list[0].kickoff))} · ${list.length} maç</div>
    <div class="match-list">${list.map(matchRow).join("")}</div>`;
}

async function viewLeague(code, tab) {
  const data = await getJSON(`${code}.json`);
  const base = `#/lig/${encodeURIComponent(code)}`;
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

function standingsHTML(data) {
  if (!data.standings.length) return `<div class="empty">Bu sezon henüz maç oynanmadı.</div>`;
  const hasXG = data.standings.some((r) => r.xgf !== null);
  const rows = data.standings.map((r) => `
    <tr>
      <td class="rank">${r.rank}</td>
      <td><span class="team-cell">${crest(r.team_id)}${esc(r.team)}</span></td>
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
  </table></div></section>`;
}

/** Sonuçlar hafta hafta; haftalar oklarla kaydırılabilen bir şeritte. */
function resultsHTML(data) {
  if (!data.results.length) return `<div class="empty">Bu sezon henüz maç oynanmadı.</div>`;

  const weeks = new Map();
  for (const r of data.results) {
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
    return `<a class="back" href="#/">← Maçlar</a>
      <div class="empty">Bu maç artık tahmin listesinde değil. Oynanmış olabilir.</div>`;
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

  return `
    <a class="back" href="#/lig/${encodeURIComponent(data.league)}">← ${esc(data.name)}</a>

    <div class="match-hero">
      <div class="hero-names">
        <div class="hero-team">
          ${crest(match.home.id, "lg")}
          <strong>${esc(match.home.name)}</strong><span>Elo ${match.home.elo}</span>
        </div>
        <div class="hero-mid">
          <strong>${timeIn(match.kickoff)}</strong>${esc(dayLabel(match.kickoff))}${week}
        </div>
        <div class="hero-team">
          ${crest(match.away.id, "lg")}
          <strong>${esc(match.away.name)}</strong><span>Elo ${match.away.elo}</span>
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
        <span><i style="background:var(--draw)"></i>Beraberlik</span>
        <span><i style="background:var(--away)"></i>Deplasman kazanır</span>
      </div>
    </div>
    ${tbd}

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

async function liveRecordHTML() {
  let data;
  try { data = await getJSON("accuracy.json"); } catch { return ""; }
  const markets = Object.values(data.markets ?? {});
  if (!markets.length) {
    return `<section class="card">
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
  return `<section class="card">
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
    <a class="back" href="#/">← Maçlar</a>
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
      <p style="margin:0">Girdiler: Elo gücü, son 5 ve 10 maçın gol ve xG
        ortalamaları, ev/deplasman formu ve dinlenme süresi. Her maçın girdileri
        yalnızca o maç başlamadan önce biten maçlardan hesaplanıyor; bu bir testle
        zorunlu kılınıyor.</p>
    </section>`;
}

// ─── Durum ve yönlendirme ──────────────────────────────────────────────────

const state = { day: null, stripStart: null, week: null };

async function route() {
  const view = el("view");
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  view.innerHTML = '<div class="loading">Yükleniyor…</div>';

  try {
    let html;
    if (parts[0] === "lig" && parts[1]) {
      html = await viewLeague(decodeURIComponent(parts[1]), parts[2]);
    } else if (parts[0] === "mac" && parts[1]) {
      html = await viewMatch(decodeURIComponent(parts[1]));
    } else if (parts[0] === "model") {
      html = await viewModel();
    } else {
      html = await viewHome();
    }
    view.innerHTML = html;
    scrollSelectedIntoView();
  } catch (err) {
    view.innerHTML = `<div class="empty">Veri yüklenemedi.<br>
      <span class="muted">${esc(err.message)}</span></div>`;
  }
  await paintNav();
}

/** Seçili hafta/gün şeridin görünmeyen kısmındaysa kendiliğinden ortalansın. */
function scrollSelectedIntoView() {
  const active = document.querySelector('.weeks .week-chip[aria-pressed="true"]');
  if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
}

el("view").addEventListener("click", (event) => {
  const day = event.target.closest(".day-btn");
  if (day) { state.day = day.dataset.day; return route(); }

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

el("view").addEventListener("change", (event) => {
  if (event.target.id !== "jump-date") return;
  state.day = event.target.value;
  state.stripStart = null;   // şerit seçilen günün etrafına yeniden konumlansın
  route();
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

  el("generated-at").textContent = `Son güncelleme: ${new Date(meta.generated_at)
    .toLocaleString("tr-TR", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" })}`;
}

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

window.addEventListener("hashchange", () => {
  state.day = null; state.stripStart = null; state.week = null;
  route();
});
route();
