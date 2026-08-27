/* Ballinc — statik ön yüz.
   Sunucu yok: pipeline'ın ürettiği data/*.json dosyalarını okuyup render eder.
   Yönlendirme hash tabanlı, böylece GitHub Pages'te ek ayar gerekmiyor. */

const TZ = "Europe/Istanbul";
const cache = new Map();

const MARKETS = [
  { key: "result",   title: "Maç Sonucu",     labels: ["1 · Ev", "X · Beraberlik", "2 · Deplasman"], fills: ["home", "draw", "away"] },
  { key: "over_2_5", title: "2.5 Alt / Üst",  labels: ["2.5 Alt", "2.5 Üst"],      fills: ["draw", "yes"] },
  { key: "btts",     title: "Karşılıklı Gol", labels: ["Yok", "Var"],              fills: ["draw", "yes"] },
];

// ─── Yardımcılar ───────────────────────────────────────────────────────────

const el = document.getElementById.bind(document);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (p) => Math.round(p * 100);

async function getJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const promise = fetch(`data/${path}`, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  });
  cache.set(path, promise);
  return promise;
}

function timeIn(iso) {
  return new Date(iso).toLocaleTimeString("tr-TR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit",
  });
}

const dayKey = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: TZ });

function dayLabel(iso) {
  const key = dayKey(iso);
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString("sv-SE", { timeZone: TZ });
  if (key === today) return "Bugün";
  if (key === tomorrow) return "Yarın";
  return new Date(iso).toLocaleDateString("tr-TR", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long",
  });
}

/** Logo indirilememiş takımlar için: kırık resim yerine sade bir yer tutucu. */
const FALLBACK_CREST =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E" +
  "%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='%23999' stroke-width='1.5'/%3E%3C/svg%3E";

const crest = (id, name, extra = "") =>
  `<img class="crest ${extra}" src="assets/teams/${encodeURIComponent(id)}.png" alt=""
        loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK_CREST}'">`;

const leagueLogo = (code, cls = "") => `
  <img class="logo-light ${cls}" src="assets/leagues/${encodeURIComponent(code)}.png" alt="" loading="lazy"
       onerror="this.style.display='none'">
  <img class="logo-dark ${cls}" src="assets/leagues/${encodeURIComponent(code)}-dark.png" alt="" loading="lazy"
       onerror="this.style.display='none'">`;

/** Bir marketin geriye dönük ölçümde baseline'ı geçip geçmediği. */
function reliability(metrics, key) {
  const m = metrics?.[key];
  if (!m) return null;
  return { reliable: m.reliable, skill: m.skill, n: m.n };
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

/** Alt/üst ve KG olasılıkları satırda doğrudan görünsün: kullanıcının
    detaya tıklaması gerektiğini bilmesi gerekmiyor. */
function extraChips(match) {
  const ou = match.markets.over_2_5;
  const bt = match.markets.btts;
  if (!ou || !bt) return "";
  const overWins = ou[1] >= ou[0];
  const bttsYes = bt[1] >= bt[0];
  return `<div class="extra">
    <span class="extra-chip">2.5 ${overWins ? "ÜST" : "ALT"} <b>%${pct(overWins ? ou[1] : ou[0])}</b></span>
    <span class="extra-chip">KG ${bttsYes ? "VAR" : "YOK"} <b>%${pct(bttsYes ? bt[1] : bt[0])}</b></span>
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

// ─── Görünümler ────────────────────────────────────────────────────────────

async function viewHome() {
  const meta = await getJSON("meta.json");
  const active = meta.leagues.filter((l) => l.upcoming > 0);
  const all = [];
  for (const league of active) {
    const data = await getJSON(`${league.code}.json`);
    all.push(...data.matches);
  }
  all.sort((a, b) => a.kickoff.localeCompare(b.kickoff));

  const idle = meta.leagues.filter((l) => l.upcoming === 0);
  const idleNote = idle.length ? `
    <p class="note">
      ${idle.map((l) => esc(l.name)).join(", ")} için bu sezon fikstür verisi
      henüz yok. Yayınlandığında otomatik olarak listeye girecek.
    </p>` : "";

  return `
    <div class="page-head">
      <div class="page-title"><h1>Yaklaşan maçlar</h1></div>
      <p class="sub">Önümüzdeki ${meta.window_days} günün maçları · ${all.length} tahmin ·
        <a href="#/model">model ne kadar isabetli?</a></p>
    </div>
    ${idleNote}
    ${matchListHTML(all)}`;
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
        %${(lgResult.skill * 100).toFixed(1)} daha iyi (${lgResult.n} maç).`
    : "";
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
      <td>${r.gf}:${r.ga}</td>
      <td>${r.gd > 0 ? "+" : ""}${r.gd}</td>
      ${hasXG ? `<td>${r.xgf ?? "—"}</td><td>${r.xga ?? "—"}</td>` : ""}
      <td>${formPills(r.form)}</td>
      <td class="pts">${r.points}</td>
    </tr>`).join("");

  return `<section class="card"><div class="table-scroll"><table>
    <thead><tr>
      <th>#</th><th>Takım</th><th>O</th><th>G</th><th>B</th><th>M</th>
      <th>A:Y</th><th>Av</th>${hasXG ? "<th>xG</th><th>xGA</th>" : ""}<th>Form</th><th>P</th>
    </tr></thead><tbody>${rows}</tbody>
  </table></div></section>`;
}

/** Sonuçlar hafta hafta. Eskiden yalnızca son 20 maç geliyordu ve sezonun
    ilk haftaları hiç görünmüyordu; artık her hafta seçilebiliyor. */
function resultsHTML(data) {
  if (!data.results.length) return `<div class="empty">Bu sezon henüz maç oynanmadı.</div>`;

  const weeks = new Map();
  for (const r of data.results) {
    const key = r.round ?? 0;
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(r);
  }
  const ordered = [...weeks.keys()].sort((a, b) => b - a);
  const selected = window.__week != null && weeks.has(window.__week)
    ? window.__week : ordered[0];

  const chips = ordered.map((w) => `
    <button class="week-chip" type="button" data-week="${w}"
            aria-pressed="${w === selected}">${w === 0 ? "Diğer" : `${w}. Hafta`}</button>`).join("");

  // Bir hafta birden çok güne yayılıyor; yalnızca saat göstermek hangi maçın
  // ne zaman oynandığını belirsiz bırakıyordu, o yüzden gün başlıkları var.
  const list = (weeks.get(selected) ?? [])
    .slice().sort((a, b) => a.kickoff.localeCompare(b.kickoff));

  const days = groupByDay(list).map(([, dayList]) => `
    <div class="date-head">${esc(dayLabel(dayList[0].kickoff))}</div>
    <div class="match-list">${dayList.map(resultRow).join("")}</div>`).join("");

  return `
    <div class="weeks" role="group" aria-label="Hafta seçimi">${chips}</div>
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
  const scores = match.top_scores.map((s) => `
    <div class="score-cell"><b>${s.home} - ${s.away}</b><span>%${(s.prob * 100).toFixed(1)}</span></div>
  `).join("");
  const tbd = match.time_confirmed === false
    ? `<p class="note">Başlama saati henüz kesinleşmedi, değişebilir.</p>` : "";
  const week = match.round ? ` · ${match.round}. Hafta` : "";

  return `
    <a class="back" href="#/lig/${encodeURIComponent(data.league)}">← ${esc(data.name)}</a>
    <div class="match-hero">
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
    ${tbd}
    ${MARKETS.map((m) => barsHTML(match.markets[m.key], m, meta.metrics)).join("")}

    <section class="card">
      <h2>En olası skorlar</h2>
      <div class="scores">${scores}</div>
      <p class="muted" style="margin:.8rem 0 0;font-size:.8rem">
        Beklenen gol · ${esc(match.home.name)} ${lh.toFixed(2)} — ${esc(match.away.name)} ${la.toFixed(2)}
      </p>
    </section>

    <section class="card">
      <h2>Form</h2>
      <div class="form-grid">
        ${[match.home, match.away].map((team) => {
          const row = standing[team.id];
          return `<div class="form-col">
            <h3>${esc(team.name)}${row ? ` · ${row.rank}. sıra, ${row.points} puan` : ""}</h3>
            ${formPills(row?.form)}
          </div>`;
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
    <tr>
      <td>${esc(m.label)}</td><td>${m.n}</td>
      <td>%${(m.accuracy * 100).toFixed(1)}</td>
      <td>%${(m.baseline_accuracy * 100).toFixed(1)}</td>
      <td>${m.logloss.toFixed(4)}</td><td>${esc(m.since)}</td>
    </tr>`).join("");
  return `<section class="card">
    <h2>Yayındaki isabet <span class="badge">${data.total} tahmin doğrulandı</span></h2>
    <div class="table-scroll"><table class="table-metrics">
      <thead><tr><th>Market</th><th>Tahmin</th><th>İsabet</th>
        <th>Baseline</th><th>Logloss</th><th>Başlangıç</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="muted" style="margin:.75rem 0 0;font-size:.8rem">
      Bu tahminler maç oynanmadan önce kaydedildi ve sonradan değiştirilmedi.</p>
  </section>`;
}

async function viewModel() {
  const meta = await getJSON("meta.json");
  const live = await liveRecordHTML();
  const rows = Object.values(meta.metrics ?? {}).map((m) => `
    <tr>
      <td>${esc(m.label)}</td><td>${m.n}</td>
      <td>${m.logloss.toFixed(4)}</td><td>${m.baseline_logloss.toFixed(4)}</td>
      <td>${(m.skill * 100).toFixed(1)}%</td>
      <td>%${(m.accuracy * 100).toFixed(1)}</td>
      <td>%${(m.baseline_accuracy * 100).toFixed(1)}</td>
      <td>${m.reliable ? '<span class="badge">güvenilir</span>'
                       : '<span class="badge weak">edge yok</span>'}</td>
    </tr>`).join("");

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
        <tbody>${rows}</tbody>
      </table></div>
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

// ─── Yönlendirme ───────────────────────────────────────────────────────────

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
    window.scrollTo(0, 0);
  } catch (err) {
    view.innerHTML = `<div class="empty">Veri yüklenemedi.<br>
      <span class="muted">${esc(err.message)}</span></div>`;
  }
  await paintNav();
}

// Hafta seçimi sayfayı yeniden yüklemeden değişsin.
el("view").addEventListener("click", (event) => {
  const chip = event.target.closest(".week-chip");
  if (!chip) return;
  window.__week = Number(chip.dataset.week);
  route();
});

async function paintNav() {
  const meta = await getJSON("meta.json");
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const active = parts[0] === "lig" ? decodeURIComponent(parts[1]) : "";

  el("league-nav").innerHTML = meta.leagues.map((l) => {
    const current = l.code === active ? ' aria-current="page"' : "";
    const idle = l.upcoming === 0 ? " idle" : "";
    return `<a class="league-tab${idle}" href="#/lig/${encodeURIComponent(l.code)}"${current}>
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

window.addEventListener("hashchange", () => { window.__week = null; route(); });
route();
