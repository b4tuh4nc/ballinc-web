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

function dayKey(iso) {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: TZ });
}

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

/** Bir marketin geriye dönük ölçümde baseline'ı geçip geçmediği. */
function reliability(metrics, key) {
  const m = metrics?.[key];
  if (!m) return null;
  return {
    reliable: m.reliable,
    skill: m.skill,
    logloss: m.logloss,
    baseline: m.baseline_logloss,
    n: m.n,
  };
}

// ─── Bileşenler ────────────────────────────────────────────────────────────

function oddsCells(match) {
  const p = match.markets.result;
  const best = p.indexOf(Math.max(...p));
  const labels = ["1", "X", "2"];
  return `<div class="odds">${p.map((v, i) => `
    <div class="odds-cell${i === best ? " best" : ""}">
      <span>${labels[i]}</span><b>%${pct(v)}</b>
    </div>`).join("")}</div>`;
}

function matchRow(match, { showLeague = false } = {}) {
  const tbd = match.time_confirmed === false
    ? '<span class="tbd">saat?</span>' : "";
  const league = showLeague ? `<span class="muted"> · ${esc(match.leagueName ?? "")}</span>` : "";
  return `
    <a class="match" href="#/mac/${encodeURIComponent(match.id)}">
      <div class="match-time">${timeIn(match.kickoff)}${tbd}</div>
      <div class="match-teams">
        <div class="team-line"><span class="team-name">${esc(match.home.name)}</span>${league}</div>
        <div class="team-line"><span class="team-name">${esc(match.away.name)}</span></div>
      </div>
      ${oddsCells(match)}
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

function matchListHTML(matches, options) {
  if (!matches.length) {
    return `<div class="empty">Bu pencerede oynanacak maç yok.</div>`;
  }
  return groupByDay(matches).map(([key, list]) => `
    <div class="date-head">${esc(dayLabel(list[0].kickoff))}</div>
    <div class="match-list">${list.map((m) => matchRow(m, options)).join("")}</div>
  `).join("");
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
    <p class="note">
      Geriye dönük ölçümde bu market, sabit taban oranı söylemekten daha iyi
      sonuç vermedi (${info.n} maç). Rakamlar model çıktısı olarak duruyor
      ama üzerine karar kurma.
    </p>` : "";

  return `<section class="card">
    <h2>${esc(market.title)} ${badge}</h2>
    <div class="bars">${rows}</div>
    ${warning}
  </section>`;
}

function formPills(form) {
  if (!form?.length) return '<span class="muted">—</span>';
  return `<div class="pills">${form.map((f) => `<span class="pill ${f}">${f}</span>`).join("")}</div>`;
}

// ─── Görünümler ────────────────────────────────────────────────────────────

async function viewHome() {
  const meta = await getJSON("meta.json");
  const active = meta.leagues.filter((l) => l.upcoming > 0);
  const all = [];

  for (const league of active) {
    const data = await getJSON(`${league.code}.json`);
    for (const m of data.matches) {
      all.push({ ...m, leagueName: `${league.flag} ${league.name}` });
    }
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
      <h1>Yaklaşan maçlar</h1>
      <p>Önümüzdeki ${meta.window_days} günün maçları · ${all.length} tahmin</p>
    </div>
    ${idleNote}
    ${matchListHTML(all, { showLeague: true })}`;
}

async function viewLeague(code, tab) {
  const data = await getJSON(`${code}.json`);
  const meta = await getJSON("meta.json");
  const base = `#/lig/${encodeURIComponent(code)}`;
  const tabs = [
    ["", "Maçlar"], ["puan", "Puan Durumu"], ["sonuclar", "Sonuçlar"],
  ].map(([slug, label]) => {
    const href = slug ? `${base}/${slug}` : base;
    const current = (tab ?? "") === slug ? ' aria-current="page"' : "";
    return `<a class="tab" href="${href}"${current}>${label}</a>`;
  }).join("");

  let body;
  if (tab === "puan") {
    body = standingsHTML(data);
  } else if (tab === "sonuclar") {
    body = resultsHTML(data);
  } else {
    body = matchListHTML(data.matches);
  }

  const xgNote = data.has_xg === false ? `
    <p class="note">
      Bu lig için xG verisi bulunmuyor; tahminler yalnızca gol ve form
      verisine dayanıyor ve diğer liglere göre daha zayıf.
    </p>` : "";

  return `
    <div class="page-head">
      <h1>${data.flag} ${esc(data.name)}</h1>
      <p>${esc(data.season)} sezonu · ${data.matches.length} yaklaşan maç</p>
      <nav class="tabs">${tabs}</nav>
    </div>
    ${xgNote}
    ${body}`;
}

function standingsHTML(data) {
  if (!data.standings.length) {
    return `<div class="empty">Bu sezon henüz maç oynanmadı.</div>`;
  }
  const hasXG = data.standings.some((r) => r.xgf !== null);
  const rows = data.standings.map((r) => `
    <tr>
      <td class="rank">${r.rank}</td>
      <td>${esc(r.team)}</td>
      <td>${r.played}</td>
      <td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
      <td>${r.gf}:${r.ga}</td>
      <td>${r.gd > 0 ? "+" : ""}${r.gd}</td>
      ${hasXG ? `<td>${r.xgf ?? "—"}</td><td>${r.xga ?? "—"}</td>` : ""}
      <td>${formPills(r.form)}</td>
      <td class="pts">${r.points}</td>
    </tr>`).join("");

  return `<section class="card"><div class="table-scroll"><table>
    <thead><tr>
      <th>#</th><th>Takım</th><th>O</th><th>G</th><th>B</th><th>M</th>
      <th>A:Y</th><th>Av</th>
      ${hasXG ? "<th>xG</th><th>xGA</th>" : ""}
      <th>Form</th><th>P</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div></section>`;
}

function resultsHTML(data) {
  if (!data.results.length) {
    return `<div class="empty">Bu sezon henüz maç oynanmadı.</div>`;
  }
  const rows = data.results.map((r) => `
    <div class="match" style="cursor:default">
      <div class="match-time">${timeIn(r.kickoff)}</div>
      <div class="match-teams">
        <div class="team-line">
          <span class="team-name">${esc(r.home.name)}</span>
          <span class="team-score">${r.score[0]}</span>
        </div>
        <div class="team-line">
          <span class="team-name">${esc(r.away.name)}</span>
          <span class="team-score">${r.score[1]}</span>
        </div>
      </div>
      <div class="odds-cell">${r.xg ? `<span>xG</span><b>${r.xg[0]} - ${r.xg[1]}</b>` : ""}</div>
    </div>`).join("");

  return groupByDay(data.results).length
    ? `<div class="date-head">Son oynanan maçlar</div><div class="match-list">${rows}</div>`
    : "";
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
    <div class="score-cell">
      <b>${s.home} - ${s.away}</b><span>%${(s.prob * 100).toFixed(1)}</span>
    </div>`).join("");

  const tbd = match.time_confirmed === false
    ? `<p class="note">Başlama saati henüz kesinleşmedi, değişebilir.</p>` : "";

  return `
    <a class="back" href="#/lig/${encodeURIComponent(data.league)}">← ${esc(data.name)}</a>
    <div class="match-hero">
      <div class="hero-team">
        <strong>${esc(match.home.name)}</strong>
        <span>Elo ${match.home.elo}</span>
      </div>
      <div class="hero-mid">
        <strong>${timeIn(match.kickoff)}</strong>
        ${esc(dayLabel(match.kickoff))}
      </div>
      <div class="hero-team">
        <strong>${esc(match.away.name)}</strong>
        <span>Elo ${match.away.elo}</span>
      </div>
    </div>
    ${tbd}
    ${MARKETS.map((m) => barsHTML(match.markets[m.key], m, meta.metrics)).join("")}

    <section class="card">
      <h2>En olası skorlar</h2>
      <div class="scores">${scores}</div>
      <p class="muted" style="margin:.75rem 0 0;font-size:.8rem">
        Beklenen gol · ${esc(match.home.name)} ${lh.toFixed(2)} —
        ${esc(match.away.name)} ${la.toFixed(2)}
      </p>
    </section>

    <section class="card">
      <h2>Form</h2>
      <div class="form-grid">
        ${[["home", match.home], ["away", match.away]].map(([side, team]) => {
          const row = standing[team.id];
          return `<div class="form-col">
            <h3>${esc(team.name)}${row ? ` · ${row.rank}. sıra, ${row.points} puan` : ""}</h3>
            ${formPills(row?.form)}
          </div>`;
        }).join("")}
      </div>
    </section>`;
}

async function viewModel() {
  const meta = await getJSON("meta.json");
  const rows = Object.entries(meta.metrics ?? {}).map(([, m]) => `
    <tr>
      <td>${esc(m.label)}</td>
      <td>${m.n}</td>
      <td>${m.logloss.toFixed(4)}</td>
      <td>${m.baseline_logloss.toFixed(4)}</td>
      <td>${(m.skill * 100).toFixed(1)}%</td>
      <td>%${(m.accuracy * 100).toFixed(1)}</td>
      <td>%${(m.baseline_accuracy * 100).toFixed(1)}</td>
      <td>${m.reliable ? '<span class="badge">güvenilir</span>'
                       : '<span class="badge weak">edge yok</span>'}</td>
    </tr>`).join("");

  return `
    <a class="back" href="#/">← Maçlar</a>
    <div class="page-head">
      <h1>Model ne kadar iyi?</h1>
      <p>Walk-forward ölçüm: her sezon, yalnızca kendisinden önce oynanmış maçlarla eğitilen modelle tahmin edildi.</p>
    </div>
    <section class="card">
      <div class="table-scroll"><table class="table-metrics">
        <thead><tr>
          <th>Market</th><th>Maç</th>
          <th>Logloss</th><th>Baseline</th><th>Kazanç</th>
          <th>İsabet</th><th>Baseline isabet</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="note">
        Logloss düşük olması iyidir ve olasılıkların ne kadar doğru olduğunu
        ölçer. Çıplak isabet oranı yanıltıcıdır: "her maça üst de" demek
        %53 isabet verir, bu bir başarı değildir. Bu yüzden bir market ancak
        logloss'u baseline'dan belirgin şekilde iyiyse güvenilir sayılıyor.
      </p>
    </section>
    <section class="card">
      <h2>Nasıl çalışıyor</h2>
      <p style="margin:0 0 .6rem">
        Model tek bir şey tahmin ediyor: her takımın o maçta atması beklenen
        gol sayısı. Bu iki sayıdan bir skor olasılık matrisi kuruluyor ve
        bütün marketler aynı matristen okunuyor — bu yüzden tahminler
        birbiriyle çelişemiyor.
      </p>
      <p style="margin:0">
        Girdiler: Elo gücü, son 5 ve 10 maçın gol ve xG ortalamaları, ev/deplasman
        formu ve dinlenme süresi. Her maçın girdileri yalnızca o maç başlamadan
        önce biten maçlardan hesaplanıyor; bu bir testle zorunlu kılınıyor.
      </p>
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
    view.innerHTML = `<div class="empty">
      Veri yüklenemedi.<br><span class="muted">${esc(err.message)}</span>
    </div>`;
  }
  await paintNav();
}

async function paintNav() {
  const meta = await getJSON("meta.json");
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const active = parts[0] === "lig" ? decodeURIComponent(parts[1]) : "";

  el("league-nav").innerHTML = meta.leagues.map((l) => {
    const current = l.code === active ? ' aria-current="page"' : "";
    const dim = l.upcoming === 0 ? ' style="opacity:.5"' : "";
    return `<a class="league-tab" href="#/lig/${encodeURIComponent(l.code)}"${current}${dim}>${l.flag} ${esc(l.name)}</a>`;
  }).join("");

  const stamp = new Date(meta.generated_at).toLocaleString("tr-TR", {
    timeZone: TZ, dateStyle: "medium", timeStyle: "short",
  });
  el("generated-at").textContent = `Son güncelleme: ${stamp}`;
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

window.addEventListener("hashchange", route);
route();
