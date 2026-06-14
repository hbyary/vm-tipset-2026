const PICKS_URL = "data/picks.json";
const FIXTURES_URL = "data/fixtures.json";
const LIVE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ESPN_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary";
const ESPN_TEAMS = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams";
const summaryCache = new Map();
const eventIdCache = new Map();

const AVATAR_PALETTE = [
  ["#facc15", "#fbbf24"],
  ["#818cf8", "#6366f1"],
  ["#34d399", "#10b981"],
  ["#f472b6", "#ec4899"],
  ["#fb7185", "#f43f5e"],
  ["#60a5fa", "#3b82f6"],
  ["#a78bfa", "#8b5cf6"],
  ["#fbbf24", "#f97316"],
  ["#2dd4bf", "#14b8a6"],
];

const $ = (sel) => document.querySelector(sel);

const state = {
  picks: null,
  fixtures: null,
  teams: {},
  live: {},
  liveFetchedAt: null,
  filter: "all",
  tab: "home",
};

function teamLogo(name) {
  return state.teams[name]?.logo || null;
}
function teamLogoHtml(name, cls = "") {
  const url = teamLogo(name);
  return url ? `<img class="team-logo ${cls}" src="${url}" alt="" loading="lazy" decoding="async">` : "";
}
function playerInitial(name) {
  return (name || "?").trim().slice(0, 1).toUpperCase();
}
function playerPalette(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  return `--av1:${a}; --av2:${b}`;
}

async function loadTeams() {
  try {
    const r = await fetch("data/teams.json", { cache: "no-store" });
    const j = await r.json();
    return j.teams || {};
  } catch (e) {
    console.warn("teams load failed", e);
    return {};
  }
}

async function load() {
  const bust = `?v=${Date.now()}`;
  const opts = { cache: "no-store" };
  const [picks, fixtures, teams] = await Promise.all([
    fetch(PICKS_URL + bust, opts).then((r) => r.json()),
    fetch(FIXTURES_URL + bust, opts).then((r) => r.json()),
    Object.keys(state.teams).length ? Promise.resolve(state.teams) : loadTeams(),
  ]);
  state.picks = picks;
  state.fixtures = fixtures;
  state.teams = teams;
  render();
}

async function refresh() {
  try {
    await load();
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

function liveWindowActive() {
  const list = state.fixtures?.matches;
  if (!list) return false;
  const now = Date.now();
  return list.some((m) => {
    if (!m.DateUtc) return false;
    const t = new Date(m.DateUtc).getTime();
    return now > t - 30 * 60_000 && now < t + 3 * 60 * 60_000;
  });
}

async function pollLive() {
  if (document.hidden) return;
  if (!liveWindowActive()) return;
  try {
    const r = await fetch(LIVE_URL, { cache: "no-store" });
    const j = await r.json();
    const map = {};
    for (const e of j.events || []) {
      const comp = e.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find((x) => x.homeAway === "home");
      const away = comp.competitors?.find((x) => x.homeAway === "away");
      if (!home || !away) continue;
      const homeName = espnTeamName(home.team.displayName);
      const awayName = espnTeamName(away.team.displayName);
      map[liveKey(homeName, awayName)] = {
        state: e.status?.type?.state,
        clock: e.status?.displayClock,
        period: e.status?.period,
        homeScore: home.score,
        awayScore: away.score,
      };
    }
    state.live = map;
    state.liveFetchedAt = Date.now();
    render();
  } catch (err) {
    console.warn("live poll failed", err);
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refresh();
    pollLive();
  }
});
setInterval(refresh, 60_000);
setInterval(pollLive, 30_000);

function findFixture(homeEn, awayEn) {
  return state.fixtures.matches.find(
    (m) => m.HomeTeam === homeEn && m.AwayTeam === awayEn,
  );
}

const ESPN_ALIAS = {
  "South Korea": "Korea Republic",
  "Iran": "IR Iran",
};
function espnTeamName(displayName) {
  return ESPN_ALIAS[displayName] || displayName;
}

function liveKey(homeEn, awayEn) {
  return `${homeEn}|${awayEn}`;
}
function findLive(homeEn, awayEn) {
  return state.live[liveKey(homeEn, awayEn)];
}

function outcomeFromScores(h, a) {
  if (h == null || a == null) return null;
  if (h > a) return "1";
  if (h < a) return "2";
  return "X";
}

function resolvedScores(m) {
  const f = findFixture(m.homeEn, m.awayEn);
  let h = f?.HomeTeamScore;
  let a = f?.AwayTeamScore;
  if (h == null || a == null) {
    const live = findLive(m.homeEn, m.awayEn);
    if (live && live.state === "post") {
      h = Number(live.homeScore);
      a = Number(live.awayScore);
    }
  }
  return { home: h, away: a, fixture: f };
}

function computeScores() {
  const { picks } = state;
  const scores = Object.fromEntries(picks.players.map((p) => [p, { pts: 0, bonus: 0 }]));

  for (const m of picks.groupStage) {
    const { home, away } = resolvedScores(m);
    const outcome = outcomeFromScores(home, away);
    if (outcome == null) continue;
    for (const p of picks.players) {
      if (m.picks[p] === outcome) scores[p].pts += picks.scoring.groupMatch;
    }
  }

  if (picks.actualWinner) {
    const target = (picks.mapping[picks.actualWinner] || picks.actualWinner).toLowerCase();
    for (const p of picks.players) {
      const guess = picks.winnerPicks[p];
      if (!guess) continue;
      const guessEn = (picks.mapping[guess] || guess).toLowerCase();
      if (guessEn === target) {
        scores[p].bonus = picks.scoring.winnerBonus;
        scores[p].pts += picks.scoring.winnerBonus;
      }
    }
  }
  return scores;
}

function renderScoreboard(scores) {
  const ordered = state.picks.players
    .map((p) => ({ name: p, ...scores[p] }))
    .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, "sv"));

  let prevPts = null;
  let rank = 0;
  let displayRank = 0;
  const html = ordered
    .map((row) => {
      rank++;
      if (row.pts !== prevPts) displayRank = rank;
      prevPts = row.pts;
      const isLeader = displayRank === 1 && row.pts > 0;
      const bonus = row.bonus ? `<span class="bonus">+${row.bonus} bonus</span>` : "";
      return `<li class="${isLeader ? "leader" : ""}" data-player="${row.name}">
        <span class="rank">${displayRank}</span>
        <span class="avatar" style="${playerPalette(row.name)}">${playerInitial(row.name)}</span>
        <span class="name">${row.name}</span>
        ${bonus}
        <span class="pts">${row.pts}</span>
      </li>`;
    })
    .join("");
  $("#scoreboard").innerHTML = html;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("sv-SE", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function renderMatches() {
  const { picks } = state;
  const rows = picks.groupStage.map((m, idx) => {
    const { home, away, fixture: f } = resolvedScores(m);
    const live = findLive(m.homeEn, m.awayEn);
    const isLive = live?.state === "in";
    const liveHome = isLive ? Number(live.homeScore) : null;
    const liveAway = isLive ? Number(live.awayScore) : null;
    const outcome = outcomeFromScores(home, away);
    const played = outcome != null;
    return { idx, m, f, live, isLive, liveHome, liveAway, homeScore: home, awayScore: away, outcome, played };
  });

  const filtered = rows.filter((r) => {
    if (state.filter === "played") return r.played;
    if (state.filter === "upcoming") return !r.played && !r.isLive;
    if (state.filter === "live") return r.isLive;
    return true;
  });

  filtered.sort((a, b) => {
    const da = a.f?.DateUtc ? new Date(a.f.DateUtc).getTime() : 0;
    const db = b.f?.DateUtc ? new Date(b.f.DateUtc).getTime() : 0;
    return da - db;
  });

  const html = filtered
    .map(({ idx, m, f, live, isLive, liveHome, liveAway, homeScore, awayScore, outcome, played }) => {
      let score, dateOrClock, articleClass = "";
      if (isLive) {
        articleClass = "match live";
        score = `<span class="match-result live">${liveHome}–${liveAway}</span>`;
        const clock = live.clock || `${live.period}'`;
        dateOrClock = `<span class="live-badge"><span class="live-dot"></span>LIVE · ${clock}</span>`;
      } else if (played) {
        articleClass = "match";
        score = `<span class="match-result">${homeScore}–${awayScore}</span>`;
        dateOrClock = `<span class="match-date">${f?.DateUtc ? formatDate(f.DateUtc) : ""}</span>`;
      } else {
        articleClass = "match";
        score = `<span class="match-result pending">vs</span>`;
        dateOrClock = `<span class="match-date">${f?.DateUtc ? formatDate(f.DateUtc) : ""}</span>`;
      }
      const outcomeBadge = played && !isLive ? `<span class="outcome-badge">${outcome}</span>` : "";
      const picksHtml = picks.players
        .map((p) => {
          const pick = m.picks[p] || "";
          const cls = !pick
            ? "empty"
            : outcome == null
              ? ""
              : pick === outcome
                ? "correct"
                : "wrong";
          return `<div class="pick ${cls}">
            <span class="who">${p}</span>
            <span class="what">${pick || "–"}</span>
          </div>`;
        })
        .join("");
      return `<article class="${articleClass}" data-idx="${idx}">
        <div class="match-head">
          <div class="match-teams">
            ${teamLogoHtml(m.homeEn)} ${m.homeSv} – ${m.awaySv} ${teamLogoHtml(m.awayEn)} ${score} ${outcomeBadge}
          </div>
          ${dateOrClock}
        </div>
        <div class="picks">${picksHtml}</div>
      </article>`;
    })
    .join("");

  $("#matches").innerHTML = html || `<p style="color:var(--muted)">Inga matcher.</p>`;
}

function renderUpdated() {
  if (!state.fixtures?.fetchedAt) return;
  const d = new Date(state.fixtures.fetchedAt);
  $("#updated").textContent = `Uppdaterad ${d.toLocaleString("sv-SE", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function computeGroupTables() {
  const table = {};
  for (const m of state.picks.groupStage) {
    const f = findFixture(m.homeEn, m.awayEn);
    if (!f?.Group) continue;
    const live = findLive(m.homeEn, m.awayEn);
    const useLive = live?.state === "post" && f.HomeTeamScore == null;
    const h = useLive ? Number(live.homeScore) : f.HomeTeamScore;
    const a = useLive ? Number(live.awayScore) : f.AwayTeamScore;
    const grp = f.Group;
    if (!table[grp]) table[grp] = {};
    const t = table[grp];
    for (const team of [m.homeEn, m.awayEn]) {
      if (!t[team]) t[team] = { name: team, sv: team === m.homeEn ? m.homeSv : m.awaySv, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
    }
    if (h == null || a == null) continue;
    t[m.homeEn].p++; t[m.awayEn].p++;
    t[m.homeEn].gf += h; t[m.homeEn].ga += a;
    t[m.awayEn].gf += a; t[m.awayEn].ga += h;
    if (h > a) { t[m.homeEn].w++; t[m.homeEn].pts += 3; t[m.awayEn].l++; }
    else if (h < a) { t[m.awayEn].w++; t[m.awayEn].pts += 3; t[m.homeEn].l++; }
    else { t[m.homeEn].d++; t[m.awayEn].d++; t[m.homeEn].pts++; t[m.awayEn].pts++; }
  }
  // Sort each group
  const out = {};
  for (const g of Object.keys(table).sort()) {
    out[g] = Object.values(table[g]).sort((x, y) =>
      y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.sv.localeCompare(y.sv, "sv"),
    );
  }
  return out;
}

function renderGroups() {
  const tables = computeGroupTables();
  const allMatches = state.picks.groupStage.map((m, idx) => ({ idx, m, f: findFixture(m.homeEn, m.awayEn) }));
  const html = Object.entries(tables)
    .map(([grp, rows]) => {
      const tableRows = rows
        .map(
          (r, i) => `<tr class="${i < 2 ? "q-top2" : i === 2 ? "q-third" : ""}">
            <td class="pos">${i + 1}</td>
            <td class="team">${teamLogoHtml(r.name, "sm")} ${r.sv}</td>
            <td>${r.p}</td>
            <td>${r.w}</td>
            <td>${r.d}</td>
            <td>${r.l}</td>
            <td>${r.gf}-${r.ga}</td>
            <td class="pts">${r.pts}</td>
          </tr>`,
        )
        .join("");
      const grpMatches = allMatches
        .filter(({ f }) => f?.Group === grp)
        .sort((x, y) => new Date(x.f.DateUtc) - new Date(y.f.DateUtc))
        .map(({ idx, m, f }) => {
          const { home, away } = resolvedScores(m);
          const live = findLive(m.homeEn, m.awayEn);
          const isLive = live?.state === "in";
          let score;
          if (isLive) score = `<span class="grp-score live">${live.homeScore}–${live.awayScore}</span>`;
          else if (home != null && away != null) score = `<span class="grp-score">${home}–${away}</span>`;
          else score = `<span class="grp-score pending">vs</span>`;
          return `<a class="grp-match" data-open-match="${idx}">
            <span class="grp-team">${teamLogoHtml(m.homeEn, "sm")} ${m.homeSv}</span>
            ${score}
            <span class="grp-team away">${m.awaySv} ${teamLogoHtml(m.awayEn, "sm")}</span>
          </a>`;
        })
        .join("");
      return `<section class="group-card">
        <h3>${grp}</h3>
        <table class="group-table">
          <thead><tr><th></th><th>Lag</th><th>S</th><th>V</th><th>O</th><th>F</th><th>Mål</th><th>P</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
        <div class="group-matches">${grpMatches}</div>
      </section>`;
    })
    .join("");
  document.getElementById("groups").innerHTML = html;
}

function playerStats(player) {
  let pts = 0, hits = 0, misses = 0, blanks = 0;
  const rows = [];
  for (const m of state.picks.groupStage) {
    const { home, away, fixture: f } = resolvedScores(m);
    const outcome = outcomeFromScores(home, away);
    const pick = m.picks[player] || "";
    let status = "pending";
    if (!pick) { blanks++; status = "empty"; }
    else if (outcome == null) status = "pending";
    else if (pick === outcome) { hits++; pts++; status = "correct"; }
    else { misses++; status = "wrong"; }
    rows.push({ m, f, home, away, outcome, pick, status });
  }
  const winnerPick = state.picks.winnerPicks[player] || "";
  const actual = state.picks.actualWinner;
  const winnerHit = actual && (state.picks.mapping[winnerPick] || winnerPick).toLowerCase() === (state.picks.mapping[actual] || actual).toLowerCase();
  return { pts: pts + (winnerHit ? 2 : 0), hits, misses, blanks, winnerPick, winnerHit, rows };
}

function openPlayer(name) {
  const st = playerStats(name);
  const items = st.rows
    .filter((r) => r.pick)
    .map((r) => {
      const dateStr = r.f?.DateUtc ? formatDate(r.f.DateUtc) : "";
      const scoreStr = r.outcome != null ? `${r.home}–${r.away}` : "vs";
      return `<li class="player-row ${r.status}">
        <span class="pr-pick">${r.pick}</span>
        <span class="pr-teams">${r.m.homeSv} – ${r.m.awaySv}</span>
        <span class="pr-score">${scoreStr}</span>
      </li>`;
    })
    .join("");
  document.getElementById("player-body").innerHTML = `
    <header class="detail-header">
      <div class="detail-teams">${name}</div>
      <div class="detail-meta">
        <span class="detail-score">${st.pts} p</span>
        <span class="player-stats">${st.hits} rätt · ${st.misses} fel · ${st.blanks} blank</span>
      </div>
    </header>
    <section class="detail-section">
      <h3>VM-vinnare-tips</h3>
      <p class="winner-pick ${st.winnerHit ? "correct" : ""}">${st.winnerPick || "–"}</p>
    </section>
    <section class="detail-section">
      <h3>Alla tips (${st.rows.filter(r => r.pick).length})</h3>
      <ul class="player-rows">${items}</ul>
    </section>
  `;
  document.getElementById("player").showModal();
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${tab}`));
  if (tab === "groups") renderGroups();
  if (tab === "knockout") renderKnockout();
  window.scrollTo(0, 0);
}

const KO_ROUNDS = [
  { round: 2, label: "32-delsfinaler", short: "32-final" },
  { round: 3, label: "Åttondelsfinaler", short: "16-final" },
  { round: 4, label: "Kvartsfinaler", short: "Kvart" },
  { round: 5, label: "Semifinaler", short: "Semi" },
  { round: 6, label: "Match om brons", short: "Brons" },
  { round: 7, label: "Final", short: "Final" },
];

function renderKnockout() {
  const list = state.fixtures?.matches || [];
  const sections = KO_ROUNDS.map(({ round, label }) => {
    const games = list.filter((m) => m.RoundNumber === round);
    if (!games.length) return "";
    const cards = games
      .sort((a, b) => new Date(a.DateUtc) - new Date(b.DateUtc))
      .map((g) => {
        const played = g.HomeTeamScore != null && g.AwayTeamScore != null;
        const score = played ? `${g.HomeTeamScore}–${g.AwayTeamScore}` : "vs";
        const dateStr = g.DateUtc ? formatDate(g.DateUtc) : "";
        const homeLogo = teamLogoHtml(g.HomeTeam);
        const awayLogo = teamLogoHtml(g.AwayTeam);
        return `<article class="ko-match">
          <div class="ko-side">${homeLogo}<span>${g.HomeTeam}</span></div>
          <div class="ko-score ${played ? "" : "pending"}">${score}</div>
          <div class="ko-side away"><span>${g.AwayTeam}</span>${awayLogo}</div>
          <div class="ko-meta">${dateStr}${g.Location ? " · " + g.Location : ""}</div>
        </article>`;
      })
      .join("");
    return `<section class="ko-round">
      <h3>${label}</h3>
      <div class="ko-grid">${cards}</div>
    </section>`;
  }).join("");

  document.getElementById("view-knockout").querySelector("section").innerHTML = `
    <h2 class="view-title">Slutspel</h2>
    <p class="ko-intro">Lagen fylls i automatiskt när gruppspelet är klart. Tipset för slutspelet öppnar 27 juni.</p>
    ${sections || '<div class="knockout-stub"><p>Slutspelsmatcherna laddas när schemat publiceras.</p></div>'}
  `;
}

function render() {
  const scores = computeScores();
  renderScoreboard(scores);
  renderMatches();
  if (state.tab === "groups") renderGroups();
  renderUpdated();
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) { switchTab(tab.dataset.tab); return; }

  const filterBtn = e.target.closest(".filter");
  if (filterBtn) {
    document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
    filterBtn.classList.add("active");
    state.filter = filterBtn.dataset.filter;
    renderMatches();
    return;
  }

  const playerRow = e.target.closest("#scoreboard li[data-player]");
  if (playerRow) { openPlayer(playerRow.dataset.player); return; }

  const grpMatch = e.target.closest("[data-open-match]");
  if (grpMatch) { openDetail(Number(grpMatch.dataset.openMatch)); return; }

  const card = e.target.closest(".match[data-idx]");
  if (card) { openDetail(Number(card.dataset.idx)); return; }

  const closeBtn = e.target.closest(".detail-close");
  if (closeBtn) {
    const which = closeBtn.dataset.close;
    document.getElementById(which === "player" ? "player" : "detail").close();
  }
});

function bindBackdropClose(id) {
  document.getElementById(id).addEventListener("click", (e) => {
    const dlg = e.currentTarget;
    const r = dlg.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) dlg.close();
  });
}
bindBackdropClose("detail");
bindBackdropClose("player");

function americanToDecimal(ml) {
  if (ml == null || isNaN(ml)) return null;
  return ml > 0 ? ml / 100 + 1 : 100 / Math.abs(ml) + 1;
}
function fmtOdds(dec) {
  if (dec == null) return "–";
  return dec >= 10 ? dec.toFixed(1) : dec.toFixed(2);
}

async function getEventId(homeEn, awayEn, dateUtc) {
  const key = `${homeEn}|${awayEn}`;
  if (eventIdCache.has(key)) return eventIdCache.get(key);
  if (!dateUtc) return null;
  const ymd = dateUtc.slice(0, 10).replace(/-/g, "");
  try {
    const r = await fetch(`${ESPN_SCOREBOARD}?dates=${ymd}`, { cache: "no-store" });
    const j = await r.json();
    for (const e of j.events || []) {
      const c = e.competitions?.[0];
      const h = c?.competitors?.find((x) => x.homeAway === "home");
      const a = c?.competitors?.find((x) => x.homeAway === "away");
      if (!h || !a) continue;
      const hn = espnTeamName(h.team.displayName);
      const an = espnTeamName(a.team.displayName);
      eventIdCache.set(`${hn}|${an}`, e.id);
    }
    return eventIdCache.get(key) || null;
  } catch (err) {
    console.warn("event id lookup failed", err);
    return null;
  }
}

async function getSummary(eventId) {
  if (summaryCache.has(eventId)) return summaryCache.get(eventId);
  const r = await fetch(`${ESPN_SUMMARY}?event=${eventId}`, { cache: "no-store" });
  if (!r.ok) throw new Error("summary " + r.status);
  const j = await r.json();
  summaryCache.set(eventId, j);
  return j;
}

function detailOddsHtml(oddsObj) {
  if (!oddsObj) return "";
  const h = americanToDecimal(oddsObj.homeTeamOdds?.moneyLine);
  const d = americanToDecimal(oddsObj.drawOdds?.moneyLine);
  const a = americanToDecimal(oddsObj.awayTeamOdds?.moneyLine);
  if (h == null && d == null && a == null) return "";
  return `<section class="detail-section">
    <h3>Marknadsodds <span class="provider">${oddsObj.provider?.name || ""}</span></h3>
    <div class="odds-grid">
      <div class="odd"><span class="lbl">1</span><span class="val">${fmtOdds(h)}</span></div>
      <div class="odd"><span class="lbl">X</span><span class="val">${fmtOdds(d)}</span></div>
      <div class="odd"><span class="lbl">2</span><span class="val">${fmtOdds(a)}</span></div>
    </div>
  </section>`;
}

function detailEventsHtml(summary) {
  const events = summary.keyEvents || summary.scoringPlays || [];
  if (!events.length) return "";
  const items = events
    .filter((e) => /goal|card|kick|penalty|sub/i.test(e.type?.text || e.text || ""))
    .map((e) => {
      const clock = e.clock?.displayValue || "";
      const team = e.team?.displayName || "";
      const text = e.text || e.type?.text || "";
      return `<li><span class="evt-clock">${clock}</span><span class="evt-team">${team}</span><span class="evt-text">${text}</span></li>`;
    });
  if (!items.length) return "";
  return `<section class="detail-section">
    <h3>Händelser</h3>
    <ul class="events-list">${items.join("")}</ul>
  </section>`;
}

function detailNewsHtml(summary) {
  const articles = summary.news?.articles || [];
  if (!articles.length) return "";
  const items = articles
    .slice(0, 4)
    .map(
      (a) =>
        `<li><a href="${a.links?.web?.href || "#"}" target="_blank" rel="noopener">${a.headline}</a><span class="news-desc">${a.description || ""}</span></li>`,
    );
  return `<section class="detail-section">
    <h3>Nyheter</h3>
    <ul class="news-list">${items.join("")}</ul>
  </section>`;
}

function detailVenueHtml(summary) {
  const v = summary.gameInfo?.venue;
  if (!v) return "";
  const where = [v.fullName, v.address?.city, v.address?.country].filter(Boolean).join(", ");
  return `<p class="detail-venue">📍 ${where}</p>`;
}

function detailOurPicksHtml(m, outcome) {
  const cells = state.picks.players
    .map((p) => {
      const pick = m.picks[p] || "";
      const cls = !pick
        ? "empty"
        : outcome == null
          ? ""
          : pick === outcome
            ? "correct"
            : "wrong";
      return `<div class="pick ${cls}"><span class="who">${p}</span><span class="what">${pick || "–"}</span></div>`;
    })
    .join("");
  return `<section class="detail-section">
    <h3>Era tips</h3>
    <div class="picks">${cells}</div>
  </section>`;
}

async function openDetail(idx) {
  const m = state.picks.groupStage[idx];
  if (!m) return;
  const dlg = document.getElementById("detail");
  const body = document.getElementById("detail-body");
  const { home, away, fixture: f } = resolvedScores(m);
  const live = findLive(m.homeEn, m.awayEn);
  const isLive = live?.state === "in";
  const outcome = outcomeFromScores(home, away);
  let scoreLine;
  if (isLive) {
    scoreLine = `<span class="detail-score live">${live.homeScore}–${live.awayScore}</span><span class="live-badge"><span class="live-dot"></span>${live.clock}</span>`;
  } else if (outcome) {
    scoreLine = `<span class="detail-score">${home}–${away}</span>`;
  } else {
    scoreLine = f?.DateUtc ? `<span class="detail-when">${formatDate(f.DateUtc)}</span>` : "";
  }
  body.innerHTML = `
    <header class="detail-header">
      <div class="detail-hero">
        <div class="detail-team-cell">
          ${teamLogoHtml(m.homeEn, "lg")}
          <span class="detail-team-name">${m.homeSv}</span>
        </div>
        <div class="detail-vs">${scoreLine || '<span class="detail-vs-txt">vs</span>'}</div>
        <div class="detail-team-cell">
          ${teamLogoHtml(m.awayEn, "lg")}
          <span class="detail-team-name">${m.awaySv}</span>
        </div>
      </div>
    </header>
    ${detailOurPicksHtml(m, outcome)}
    <div id="detail-extra"><p class="detail-loading">Hämtar matchdetaljer…</p></div>
  `;
  dlg.showModal();

  try {
    const eid = await getEventId(m.homeEn, m.awayEn, f?.DateUtc);
    if (!eid) {
      document.getElementById("detail-extra").innerHTML = `<p class="detail-empty">Inga detaljer från ESPN än — kommer närmare matchstart.</p>${detailVenueHtml({ gameInfo: { venue: f?.Location ? { fullName: f.Location } : null } })}`;
      return;
    }
    const summary = await getSummary(eid);
    const oddsObj = summary.pickcenter?.[0] || summary.odds?.[0];
    document.getElementById("detail-extra").innerHTML = `
      ${detailOddsHtml(oddsObj)}
      ${detailProbabilityHtml(oddsObj, m)}
      ${detailFormHtml(summary)}
      ${detailH2HHtml(summary)}
      ${detailEventsHtml(summary)}
      ${detailNewsHtml(summary)}
      ${detailVenueHtml(summary)}
    `;
  } catch (err) {
    document.getElementById("detail-extra").innerHTML = `<p class="detail-empty">Kunde inte hämta detaljer (${err.message}).</p>`;
  }
}

function detailProbabilityHtml(oddsObj, m) {
  if (!oddsObj) return "";
  const h = americanToDecimal(oddsObj.homeTeamOdds?.moneyLine);
  const d = americanToDecimal(oddsObj.drawOdds?.moneyLine);
  const a = americanToDecimal(oddsObj.awayTeamOdds?.moneyLine);
  if (h == null || d == null || a == null) return "";
  const inv = [1 / h, 1 / d, 1 / a];
  const sum = inv.reduce((x, y) => x + y, 0);
  const probs = inv.map((p) => p / sum);
  const pct = probs.map((p) => Math.round(p * 100));
  return `<section class="detail-section">
    <h3>Vinstsannolikhet <span class="provider">(implicit ur odds)</span></h3>
    <div class="prob-rows">
      <div class="prob-row"><span class="prob-lbl">${m.homeSv}</span><span class="prob-bar"><span class="prob-fill" style="width:${pct[0]}%; background:linear-gradient(90deg,#34d399,#10b981)"></span></span><span class="prob-pct">${pct[0]}%</span></div>
      <div class="prob-row"><span class="prob-lbl">Oavgjort</span><span class="prob-bar"><span class="prob-fill" style="width:${pct[1]}%; background:linear-gradient(90deg,#94a3b8,#64748b)"></span></span><span class="prob-pct">${pct[1]}%</span></div>
      <div class="prob-row"><span class="prob-lbl">${m.awaySv}</span><span class="prob-bar"><span class="prob-fill" style="width:${pct[2]}%; background:linear-gradient(90deg,#facc15,#f59e0b)"></span></span><span class="prob-pct">${pct[2]}%</span></div>
    </div>
  </section>`;
}

function formDots(events) {
  return (events || []).slice(-5).map((e) => {
    const r = e.gameResult;
    const cls = r === "W" ? "w" : r === "L" ? "l" : "d";
    return `<span class="form-dot ${cls}" title="${e.opponent?.displayName || ""} ${e.score || ""}">${r || "?"}</span>`;
  }).join("");
}

function detailFormHtml(summary) {
  const sets = summary.lastFiveGames;
  if (!Array.isArray(sets) || !sets.length) return "";
  const rows = sets
    .map((s) => {
      const name = s.team?.displayName || "";
      const dots = formDots(s.events);
      if (!dots) return "";
      return `<div class="form-row">
        <span class="form-team">${name}</span>
        <span class="form-dots">${dots}</span>
      </div>`;
    })
    .filter(Boolean)
    .join("");
  if (!rows) return "";
  return `<section class="detail-section">
    <h3>Form (senaste 5)</h3>
    <div class="form-rows">${rows}</div>
  </section>`;
}

function detailH2HHtml(summary) {
  const h2h = summary.headToHeadGames;
  if (!h2h?.events?.length) return "";
  const events = h2h.events.slice(0, 5);
  const list = events
    .map((e) => {
      const date = e.gameDate ? new Date(e.gameDate).toLocaleDateString("sv-SE", { year: "numeric", month: "short" }) : "";
      const score = `${e.homeTeamScore}-${e.awayTeamScore}`;
      const opp = e.opponent?.displayName || "";
      return `<li>
        <span class="h2h-date">${date}</span>
        <span class="h2h-vs">vs ${opp}</span>
        <span class="h2h-score">${score}</span>
      </li>`;
    })
    .join("");
  return `<section class="detail-section">
    <h3>Head-to-head (senaste ${events.length})</h3>
    <ul class="h2h-list">${list}</ul>
  </section>`;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("sw.js").catch(() => {}),
  );
}

load()
  .then(() => pollLive())
  .catch((err) => {
    console.error(err);
    $("#scoreboard").innerHTML = `<li><span>Kunde inte ladda data: ${err.message}</span></li>`;
  });
