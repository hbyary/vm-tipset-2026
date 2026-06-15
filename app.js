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
  lastChecked: null,
  filter: "all",
  tab: "home",
  koRound: 4,
};

const FD_TO_ESPN = {
  "Bosnia and Herzegovina": "Bosnia-Herzegovina",
  "Cabo Verde": "Cape Verde",
  "Côte d'Ivoire": "Ivory Coast",
  "IR Iran": "Iran",
  "Korea Republic": "South Korea",
  "USA": "United States",
};
function teamLogo(name) {
  if (!name) return null;
  const t = state.teams[name] || state.teams[FD_TO_ESPN[name]];
  return t?.logo || null;
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
  state.lastChecked = Date.now();
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
// Static data refresh aligned to each whole minute (:00)
function startMinuteRefresh() {
  const msToNextMinute = 60_000 - (Date.now() % 60_000);
  setTimeout(() => {
    refresh();
    setInterval(refresh, 60_000);
  }, msToNextMinute);
}
startMinuteRefresh();
// Live poll: every 10s during live windows, otherwise every 2 min to detect kickoffs early
let livePollTimer = null;
function tuneLivePoll() {
  const fast = liveWindowActive();
  const interval = fast ? 10_000 : 120_000;
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = setInterval(pollLive, interval);
}
setInterval(tuneLivePoll, 60_000);
tuneLivePoll();
window.addEventListener("focus", () => { refresh(); pollLive(); });

function findFixture(homeEn, awayEn) {
  return state.fixtures.matches.find(
    (m) => m.HomeTeam === homeEn && m.AwayTeam === awayEn,
  );
}

function isRamenMatch(m) {
  const a = new Set([m.homeEn, m.awayEn]);
  return a.has("Sweden") && a.has("Japan");
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
  const ranked = ordered.map((row) => {
    rank++;
    if (row.pts !== prevPts) displayRank = rank;
    prevPts = row.pts;
    return { ...row, displayRank };
  });

  const top3 = ranked.slice(0, 3);
  const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean);
  const slotByIndex = ["silver", "gold", "bronze"];
  const podiumHtml = podiumOrder
    .map((r, i) => {
      const slot = top3.indexOf(r) === 0 ? 1 : top3.indexOf(r) === 1 ? 2 : 3;
      const medal = slot === 1 ? "🥇" : slot === 2 ? "🥈" : "🥉";
      return `<div class="pod pod-${slot}" data-player="${r.name}">
        <div class="pod-medal">${medal}</div>
        <div class="pod-avatar" style="${playerPalette(r.name)}">${playerInitial(r.name)}</div>
        <div class="pod-name">${r.name}</div>
        <div class="pod-pts">${r.pts}<span>p</span></div>
      </div>`;
    })
    .join("");
  document.getElementById("podium").innerHTML = podiumHtml;

  const top3Set = new Set(top3);
  const rest = ranked.filter((r) => !top3Set.has(r));
  const html = rest
    .map((row) => {
      const bonus = row.bonus ? `<span class="bonus">+${row.bonus} bonus</span>` : "";
      return `<li data-player="${row.name}">
        <span class="rank">${row.displayRank}</span>
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

  let lastDay = null;
  const html = filtered
    .map((row) => {
      let block = "";
      const dayKey = row.f?.DateUtc ? new Date(row.f.DateUtc).toISOString().slice(0, 10) : "tbd";
      if (dayKey !== lastDay) {
        lastDay = dayKey;
        block += `<div class="day-divider">${dayLabel(row.f?.DateUtc)}</div>`;
      }
      return block + matchCardHtml(row);
    })
    .join("");

  $("#matches").innerHTML = html || `<p class="empty-state">Inga matcher i denna vy.</p>`;
}

function dayLabel(iso) {
  if (!iso) return "Datum TBD";
  const d = new Date(iso);
  const today = new Date();
  const toKey = (x) => x.toISOString().slice(0, 10);
  const dayMs = 86400000;
  const diff = Math.round((new Date(toKey(d)) - new Date(toKey(today))) / dayMs);
  if (diff === 0) return "Idag";
  if (diff === 1) return "Imorgon";
  if (diff === -1) return "Igår";
  return d.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" });
}

function matchCardHtml(row) {
  const { idx, m, f, live, isLive, homeScore, awayScore, outcome, played } = row;
  const picks = state.picks;
  const time = f?.DateUtc
    ? new Date(f.DateUtc).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })
    : "";
  let center, articleClass = "match";
  if (isLive) {
    articleClass = "match live";
    center = `<div class="mc-score live">${live.homeScore}–${live.awayScore}</div><div class="mc-status"><span class="live-dot"></span>${live.clock || ""}</div>`;
  } else if (played) {
    center = `<div class="mc-score">${homeScore}–${awayScore}</div><div class="mc-status res-${outcome}">${outcome}</div>`;
  } else {
    center = `<div class="mc-time">${time}</div><div class="mc-status">kommande</div>`;
  }
  const picksHtml = picks.players
    .map((p) => {
      const pick = m.picks[p] || "";
      const cls = !pick ? "empty" : outcome == null ? "" : pick === outcome ? "correct" : "wrong";
      return `<div class="pick ${cls}"><span class="who">${p}</span><span class="what">${pick || "–"}</span></div>`;
    })
    .join("");
  const magnusBadge = isRamenMatch(m) ? `<div class="magnus-badge">🎟️ Ramen on tour</div>` : "";
  return `<article class="${articleClass}" data-idx="${idx}">
    <div class="mc-fixture">
      <div class="mc-team home">
        ${teamLogoHtml(m.homeEn)}
        <span class="mc-name">${m.homeSv}</span>
      </div>
      <div class="mc-center">${center}</div>
      <div class="mc-team away">
        <span class="mc-name">${m.awaySv}</span>
        ${teamLogoHtml(m.awayEn)}
      </div>
    </div>
    ${magnusBadge}
    <div class="picks">${picksHtml}</div>
  </article>`;
}

function renderUpdated() {
  const latest = state.liveFetchedAt || state.lastChecked;
  if (!latest) return;
  const d = new Date(latest);
  const t = d.toLocaleString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const fixt = state.fixtures?.fetchedAt ? new Date(state.fixtures.fetchedAt) : null;
  const dataAge = fixt ? Math.round((Date.now() - fixt.getTime()) / 60_000) : null;
  const ageTxt = dataAge != null && dataAge < 120 ? ` · senaste data ${dataAge}m gammal` : "";
  $("#updated").textContent = `Synkad ${t}${ageTxt}`;
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

function mode(arr) {
  const c = {};
  let best = null, bestN = 0;
  for (const v of arr) { c[v] = (c[v] || 0) + 1; if (c[v] > bestN) { bestN = c[v]; best = v; } }
  return best;
}

function playerInsights(name) {
  const players = state.picks.players;
  const others = players.filter((p) => p !== name);
  const counts = { "1": 0, X: 0, "2": 0 };
  const bucket = { "1": { n: 0, c: 0 }, X: { n: 0, c: 0 }, "2": { n: 0, c: 0 } };
  let totalPicks = 0, played = 0, correct = 0;
  let loneWins = 0, loneLosses = 0, blindSpots = 0, unique = 0, gimme = 0;
  const agree = {}; others.forEach((o) => (agree[o] = { same: 0, both: 0 }));

  // chronological for streaks
  const chrono = state.picks.groupStage
    .map((m) => ({ m, f: findFixture(m.homeEn, m.awayEn) }))
    .filter((x) => x.f?.DateUtc)
    .sort((a, b) => new Date(a.f.DateUtc) - new Date(b.f.DateUtc));

  const seq = [];
  for (const { m } of chrono) {
    const pick = m.picks[name];
    if (pick) { totalPicks++; counts[pick] = (counts[pick] || 0) + 1; }

    // agreement
    for (const o of others) {
      if (pick && m.picks[o]) { agree[o].both++; if (m.picks[o] === pick) agree[o].same++; }
    }
    // uniqueness
    if (pick && !others.some((o) => m.picks[o] === pick)) unique++;

    const { home, away } = resolvedScores(m);
    const outcome = outcomeFromScores(home, away);
    if (outcome == null || !pick) continue;

    played++;
    bucket[pick].n++;
    const isCorrect = pick === outcome;
    if (isCorrect) { correct++; bucket[pick].c++; }
    seq.push(isCorrect);

    // field context for this match
    const pickers = players.filter((p) => m.picks[p]);
    const sameAsMe = pickers.filter((p) => m.picks[p] === pick).length;
    const othersPicks = others.map((o) => m.picks[o]).filter(Boolean);
    const fieldMajority = mode(othersPicks);
    const fieldGotIt = fieldMajority === outcome;

    if (isCorrect && sameAsMe <= Math.ceil(pickers.length * 0.4)) loneWins++;
    if (isCorrect && fieldGotIt && sameAsMe >= pickers.length) gimme++;
    if (!isCorrect && fieldGotIt) blindSpots++;
    if (!isCorrect && pick !== fieldMajority && !fieldGotIt) loneLosses++;
  }

  // streaks
  let bestStreak = 0, run = 0;
  for (const ok of seq) { run = ok ? run + 1 : 0; bestStreak = Math.max(bestStreak, run); }
  let curStreak = 0;
  for (let i = seq.length - 1; i >= 0; i--) { if (seq[i]) curStreak++; else break; }

  // twin & rival
  let twin = null, rival = null;
  for (const o of others) {
    const a = agree[o];
    if (a.both < 8) continue;
    const sim = a.same / a.both;
    if (!twin || sim > twin.sim) twin = { name: o, sim, both: a.both };
    if (!rival || sim < rival.sim) rival = { name: o, sim, both: a.both };
  }

  // standing context
  const allScores = players.map((p) => ({ name: p, pts: playerStats(p).pts }));
  allScores.sort((a, b) => b.pts - a.pts);
  const myPts = allScores.find((s) => s.name === name).pts;
  const myRank = allScores.findIndex((s) => s.name === name) + 1;
  const leaderPts = allScores[0].pts;
  const avgPts = allScores.reduce((s, x) => s + x.pts, 0) / allScores.length;
  const remaining = chrono.filter(({ m }) => {
    const { home, away } = resolvedScores(m);
    return outcomeFromScores(home, away) == null && m.picks[name];
  }).length;

  const hitRate = played ? Math.round((100 * correct) / played) : null;
  const bRate = (k) => (bucket[k].n ? Math.round((100 * bucket[k].c) / bucket[k].n) : null);
  const pct = (n) => (totalPicks ? Math.round((100 * n) / totalPicks) : 0);

  return {
    name, counts, pct, totalPicks, played, correct, hitRate,
    bucket, bRate, loneWins, loneLosses, blindSpots, unique, gimme,
    curStreak, bestStreak, twin, rival,
    myPts, myRank, leaderPts, avgPts, remaining,
    winner: state.picks.winnerPicks[name] || "",
  };
}

// Build punchy, data-driven insight sentences (the "wow" layer)
function playerNarrative(ix) {
  const out = [];
  const favBucket = ["1", "X", "2"].sort((a, b) => ix.counts[b] - ix.counts[a])[0];
  const favName = { "1": "hemmaseger", X: "kryss", "2": "bortaseger" }[favBucket];
  const favPct = ix.pct(ix.counts[favBucket]);

  // 1. Identity / bias + payoff
  if (ix.played >= 3 && ix.bRate(favBucket) != null) {
    const r = ix.bRate(favBucket);
    const verdict = r >= 60 ? "och det lönar sig" : r <= 35 ? "men det straffar sig" : "med blandat utfall";
    out.push({ icon: "🎯", t: `Lutar mot ${favName} (${favPct}% av tipsen) — träffar ${r}% av dem, ${verdict}.` });
  } else {
    out.push({ icon: "🎯", t: `Tippar ${favName} oftast (${favPct}% av alla tips).` });
  }

  // 2. Lone wolf / contrarian edge
  if (ix.loneWins > 0) {
    out.push({ icon: "🐺", t: `Ensamvarg-bonus: ${ix.loneWins} rätt där få andra vågade samma — det är här ${ix.name} tjänar mark på fältet.` });
  } else if (ix.played >= 5) {
    out.push({ icon: "🐑", t: `Säker spelare: nästan alla rätt kom från matcher där fältet höll med. Inga djärva kupp ännu.` });
  }

  // 3. Blind spot
  if (ix.blindSpots > 0) {
    out.push({ icon: "🕳️", t: `Blind fläck: ${ix.blindSpots} ${ix.blindSpots === 1 ? "match" : "matcher"} där alla andra prickade rätt utom ${ix.name}.` });
  }

  // 4. Twin
  if (ix.twin && ix.twin.sim >= 0.7) {
    out.push({ icon: "👯", t: `Tipstvilling med ${ix.twin.name} — ${Math.round(ix.twin.sim * 100)}% identiska tips. Svårt att vinna ligan om de tippar likadant.` });
  }
  // 5. Rival / independence
  if (ix.rival && ix.rival.sim <= 0.45) {
    out.push({ icon: "⚔️", t: `Störst oenighet med ${ix.rival.name} (bara ${Math.round(ix.rival.sim * 100)}% lika) — deras inbördes resultat avgör mycket.` });
  }

  // 6. Uniqueness
  if (ix.unique >= 3) {
    out.push({ icon: "💎", t: `${ix.unique} helt unika tips som ingen annan i gänget har — hög egen profil.` });
  }

  // 7. Streak
  if (ix.curStreak >= 2) out.push({ icon: "🔥", t: `Hett just nu: ${ix.curStreak} rätt i rad.` });
  else if (ix.bestStreak >= 3) out.push({ icon: "📈", t: `Längsta svit: ${ix.bestStreak} rätt i rad.` });

  // 8. Standing context
  if (ix.played >= 1) {
    if (ix.myRank === 1) out.push({ icon: "👑", t: `Leder ligan med ${ix.myPts} p, ${(ix.myPts - ix.avgPts).toFixed(1)} p över snittet.` });
    else out.push({ icon: "📊", t: `${ix.myPts} p — plats ${ix.myRank}, ${ix.leaderPts - ix.myPts} p bakom ledaren. ${ix.remaining} tippade matcher kvar att hämta in på.` });
  }

  return out;
}

function openPlayer(name) {
  const st = playerStats(name);
  const ix = playerInsights(name);
  const narr = playerNarrative(ix);

  const insightCards = narr
    .map((n) => `<div class="insight"><span class="insight-ico">${n.icon}</span><span class="insight-txt">${n.t}</span></div>`)
    .join("");

  const bRateTxt = (k) => (ix.bRate(k) == null ? "–" : `${ix.bRate(k)}%`);
  const dist = `
    <div class="pat-dist">
      <div class="pat-cell"><span class="pat-lbl">Hemma · 1</span><span class="pat-val">${ix.counts["1"]}</span><span class="pat-pct">träff ${bRateTxt("1")}</span></div>
      <div class="pat-cell"><span class="pat-lbl">Kryss · X</span><span class="pat-val">${ix.counts.X}</span><span class="pat-pct">träff ${bRateTxt("X")}</span></div>
      <div class="pat-cell"><span class="pat-lbl">Borta · 2</span><span class="pat-val">${ix.counts["2"]}</span><span class="pat-pct">träff ${bRateTxt("2")}</span></div>
    </div>`;

  const items = st.rows
    .filter((r) => r.pick)
    .map((r) => {
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
      <div class="player-hero">
        <span class="avatar lg" style="${playerPalette(name)}">${playerInitial(name)}</span>
        <div>
          <div class="detail-teams">${name}</div>
          <div class="detail-meta">
            <span class="detail-score">${st.pts} p</span>
            <span class="player-stats">${ix.correct} rätt av ${ix.played} · ${ix.hitRate != null ? ix.hitRate + "% träff" : "inga avgjorda"}</span>
          </div>
        </div>
      </div>
    </header>
    <section class="detail-section">
      <h3>Djupanalys</h3>
      <div class="insights">${insightCards}</div>
    </section>
    <section class="detail-section">
      <h3>1X2-profil &amp; utdelning</h3>
      ${dist}
    </section>
    <section class="detail-section">
      <h3>VM-vinnare-tips</h3>
      <p class="winner-pick ${st.winnerHit ? "correct" : ""}">${st.winnerPick || "–"}</p>
    </section>
    ${collapsible("Alla tips (" + st.rows.filter((r) => r.pick).length + ")", `<section class="detail-section"><h3>x</h3><ul class="player-rows">${items}</ul></section>`)}
  `;
  document.documentElement.classList.add("modal-open");
  document.getElementById("player").showModal();
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${tab}`));
  if (tab === "groups") renderGroups();
  if (tab === "knockout") renderKnockout();
  if (tab === "sweden") renderSweden();
  if (tab === "highlights") renderHighlights();
  window.scrollTo(0, 0);
}

function swedenMatches() {
  return state.picks.groupStage
    .map((m, idx) => ({ m, idx, f: findFixture(m.homeEn, m.awayEn) }))
    .filter(({ m }) => m.homeEn === "Sweden" || m.awayEn === "Sweden")
    .sort((a, b) => new Date(a.f?.DateUtc || 0) - new Date(b.f?.DateUtc || 0));
}

function swedenBase() {
  const games = swedenMatches();
  let played = 0, pts = 0, gf = 0, ga = 0, w = 0, d = 0, l = 0;
  const remaining = [], playedGames = [];
  for (const g of games) {
    const { home, away } = resolvedScores(g.m);
    const live = findLive(g.m.homeEn, g.m.awayEn);
    if (home == null || away == null) { remaining.push(g); continue; }
    played++;
    const isHome = g.m.homeEn === "Sweden";
    const swe = isHome ? home : away;
    const opp = isHome ? away : home;
    gf += swe; ga += opp;
    let res;
    if (swe > opp) { pts += 3; w++; res = "V"; }
    else if (swe === opp) { pts += 1; d++; res = "O"; }
    else { l++; res = "F"; }
    playedGames.push({ ...g, swe, opp, res });
  }
  const tables = computeGroupTables();
  const grpF = tables["Group F"] || [];
  const sweRank = grpF.findIndex((r) => r.name === "Sweden") + 1 || null;
  return { games, played, pts, gf, ga, w, d, l, remaining, playedGames, grpF, sweRank };
}

async function swedenMarket(remaining) {
  // For each remaining Sweden game, fetch odds → Sweden win/draw probability
  const out = [];
  for (const g of remaining) {
    let pWin = null, pDraw = null;
    try {
      const eid = await getEventId(g.m.homeEn, g.m.awayEn, g.f?.DateUtc);
      if (eid) {
        const summary = await getSummary(eid);
        const probs = impliedProbs(summary.pickcenter?.[0] || summary.odds?.[0]);
        if (probs) {
          const isHome = g.m.homeEn === "Sweden";
          pWin = isHome ? probs.home : probs.away;
          pDraw = probs.draw;
        }
      }
    } catch (e) { /* ignore */ }
    out.push({ ...g, pWin, pDraw });
  }
  return out;
}

async function swedenNews() {
  // Pull Sweden-tagged news from any Sweden match summary
  const games = swedenMatches();
  for (const g of games) {
    try {
      const eid = await getEventId(g.m.homeEn, g.m.awayEn, g.f?.DateUtc);
      if (!eid) continue;
      const summary = await getSummary(eid);
      const arts = (summary.news?.articles || []).filter((a) =>
        (a.categories || []).some((c) => c.type === "team" && /sweden/i.test(c.description || "")),
      );
      if (arts.length) return arts.slice(0, 3);
    } catch (e) { /* ignore */ }
  }
  return [];
}

function swedenNarrative(base, market) {
  const out = [];
  const { played, pts, gf, ga, w, d, l, remaining, sweRank, grpF } = base;
  const oppName = (g) => (g.m.homeEn === "Sweden" ? g.m.awaySv : g.m.homeSv);

  // 1. Status line
  if (played === 0) {
    out.push({ icon: "🇸🇪", t: `Sverige möter ${base.games.map(oppName).join(", ")} i Grupp F. Topp 2 går vidare direkt, plus de 8 bästa treorna av 12 — i praktiken brukar 4 p räcka för avancemang, 7 p vinner gruppen.` });
  } else {
    out.push({ icon: "📊", t: `${pts} p efter ${played} ${played === 1 ? "match" : "matcher"} (${w}V ${d}O ${l}F, mål ${gf}–${ga}) — ${sweRank}:a i Grupp F.` });
  }

  // 2. Qualification math (format-aware)
  const maxRem = remaining.length * 3;
  const projMax = pts + maxRem;
  if (remaining.length > 0 && played > 0) {
    const need2nd = Math.max(0, 4 - pts);
    const need1st = Math.max(0, 7 - pts);
    if (projMax < 3) out.push({ icon: "❌", t: `Matematiskt mycket tungt: når som mest ${projMax} p, vilket sällan räcker ens som bästa trea.` });
    else if (need2nd === 0) out.push({ icon: "✅", t: `Redan på ${pts} p — historiskt nog för åtminstone andraplats. Fokus nu på gruppseger och seedning.` });
    else {
      const phrase = need2nd <= 1 ? "1 poäng (oavgjort räcker)" : need2nd <= 3 ? "en vinst" : `${need2nd} p`;
      out.push({ icon: "🎯", t: `Behöver ~${phrase} av ${maxRem} möjliga för trygg andraplats. Gruppseger kräver ytterligare ${need1st} p.` });
    }
  } else if (played === 3) {
    if (sweRank <= 2) out.push({ icon: "✅", t: `Klart för slutspel som ${sweRank === 1 ? "gruppvinnare" : "tvåa"}.` });
    else if (sweRank === 3) out.push({ icon: "⏳", t: `3:a med ${pts} p — avancemang hänger på bästa-trea-racet mot övriga grupper. ${pts >= 4 ? "4 p ger ofta en plats." : "Under 4 p är det nervöst."}` });
    else out.push({ icon: "❌", t: `Utslagna — ${sweRank}:a i gruppen räcker inte.` });
  }

  // 3. Market expectation for remaining matches
  const withOdds = market.filter((g) => g.pWin != null);
  if (withOdds.length) {
    const xPts = withOdds.reduce((s, g) => s + 3 * g.pWin + 1 * g.pDraw, 0);
    const projFinal = pts + xPts;
    const detail = withOdds
      .map((g) => `${oppName(g)} ${Math.round(g.pWin * 100)}% vinst`)
      .join(", ");
    let bucket;
    if (projFinal >= 6.5) bucket = "marknaden ser Sverige som klar favorit att gå vidare";
    else if (projFinal >= 4) bucket = "marknaden lutar åt avancemang men med marginal";
    else bucket = "marknaden ser Sverige som underdog att ta sig vidare";
    out.push({ icon: "💰", t: `Marknadens odds ger Sverige i snitt ${xPts.toFixed(1)} p på resterande (${detail}) → ~${projFinal.toFixed(1)} p totalt. Kort sagt: ${bucket}.` });
  }

  // 4. Biggest threat / rival form in group
  const rivals = grpF.filter((r) => r.name !== "Sweden");
  if (rivals.length && played > 0) {
    const top = rivals[0];
    if (grpF[0] && grpF[0].name !== "Sweden") {
      out.push({ icon: "⚠️", t: `${top.sv} leder gruppen (${top.pts} p, mål ${top.gf}–${top.ga}) och är just nu det lag Sverige jagar.` });
    } else {
      const chaser = rivals.sort((a, b) => b.pts - a.pts)[0];
      out.push({ icon: "👀", t: `Närmaste utmanare är ${chaser.sv} på ${chaser.pts} p — den inbördes matchen kan bli avgörande.` });
    }
  }

  // 5. Form read
  if (played >= 2) {
    const scored = gf / played, conceded = ga / played;
    if (conceded >= 1.5) out.push({ icon: "🛡️", t: `Defensiv oro: ${conceded.toFixed(1)} insläppta per match. Sverige måste täta till bakåt för att hålla undan.` });
    else if (scored < 1) out.push({ icon: "🥶", t: `Måltorka: bara ${gf} mål på ${played} matcher. Avslutet måste vässas.` });
  }

  return out;
}

async function renderSweden() {
  const el = document.getElementById("sweden");
  const base = swedenBase();
  if (!base.games.length) {
    el.innerHTML = `<p class="empty-state">Inga Sverige-matcher i schemat.</p>`;
    return;
  }

  const matchCards = base.games
    .map(({ m, idx, f }) => {
      const { home, away } = resolvedScores(m);
      const live = findLive(m.homeEn, m.awayEn);
      const isLive = live?.state === "in";
      let scoreLine;
      if (isLive) scoreLine = `<span class="se-score live">${live.homeScore}–${live.awayScore} · ${live.clock}</span>`;
      else if (home != null) scoreLine = `<span class="se-score">${home}–${away}</span>`;
      else scoreLine = `<span class="se-score pending">${f?.DateUtc ? formatDate(f.DateUtc) : ""}</span>`;
      const ramenBadge = isRamenMatch(m) ? `<span class="magnus-badge">🎟️ Ramen on tour</span>` : "";
      return `<article class="match" data-idx="${idx}">
        <div class="mc-fixture">
          <div class="mc-team home">${teamLogoHtml(m.homeEn)}<span class="mc-name">${m.homeSv}</span></div>
          <div class="mc-center">${scoreLine}</div>
          <div class="mc-team away"><span class="mc-name">${m.awaySv}</span>${teamLogoHtml(m.awayEn)}</div>
        </div>
        ${ramenBadge}
      </article>`;
    })
    .join("");

  const tableRows = base.grpF
    .map(
      (r, i) => `<tr class="${i < 2 ? "q-top2" : i === 2 ? "q-third" : ""} ${r.name === "Sweden" ? "is-sweden" : ""}">
        <td class="pos">${i + 1}</td>
        <td class="team">${teamLogoHtml(r.name, "sm")} ${r.sv}</td>
        <td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
        <td>${r.gf}-${r.ga}</td><td class="pts">${r.pts}</td>
      </tr>`,
    )
    .join("");

  el.innerHTML = `
    <section class="se-summary">
      <div class="se-kpi"><span class="se-kpi-lbl">Poäng</span><span class="se-kpi-val">${base.pts}</span></div>
      <div class="se-kpi"><span class="se-kpi-lbl">Mål</span><span class="se-kpi-val">${base.gf}-${base.ga}</span></div>
      <div class="se-kpi"><span class="se-kpi-lbl">Position</span><span class="se-kpi-val">${base.sweRank ? base.sweRank + ":a" : "–"}</span></div>
    </section>
    <section class="detail-section">
      <h3>Proffsanalys</h3>
      <div id="se-insights" class="insights"><div class="skel skel-line"></div><div class="skel skel-line"></div></div>
    </section>
    <section class="detail-section">
      <h3>Sveriges matcher</h3>
      <div>${matchCards}</div>
    </section>
    <section class="detail-section">
      <h3>Grupp F</h3>
      <div class="group-card" style="margin:0">
        <table class="group-table">
          <thead><tr><th></th><th>Lag</th><th>S</th><th>V</th><th>O</th><th>F</th><th>Mål</th><th>P</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </section>
    <div id="se-news" class="detail-section"></div>
  `;

  // Async enrich: odds-based market + news
  const market = await swedenMarket(base.remaining);
  const narr = swedenNarrative(base, market);
  const insEl = document.getElementById("se-insights");
  if (insEl) {
    insEl.innerHTML = narr
      .map((n) => `<div class="insight"><span class="insight-ico">${n.icon}</span><span class="insight-txt">${n.t}</span></div>`)
      .join("");
  }
  const news = await swedenNews();
  const newsEl = document.getElementById("se-news");
  if (newsEl && news.length) {
    newsEl.innerHTML = `<h3>Senaste om Sverige</h3><ul class="news-list">${news
      .map((a) => `<li><a href="${a.links?.web?.href || "#"}" target="_blank" rel="noopener">${a.headline}</a>${a.description ? `<span class="news-desc">${a.description}</span>` : ""}</li>`)
      .join("")}</ul>`;
  }
}

function extractGoals(summary) {
  const out = [];
  for (const e of summary.keyEvents || []) {
    const t = (e.type?.text || "").toLowerCase();
    if (!t.includes("goal")) continue;
    if (t.includes("own")) continue; // own goals not credited
    const scorer = e.participants?.[0]?.athlete?.displayName;
    if (!scorer) continue;
    const isPen = /penalty/i.test(e.text || "") || t.includes("penalty");
    out.push({ scorer, team: e.team?.displayName || "", penalty: isPen });
  }
  return out;
}

async function renderHighlights() {
  const container = document.getElementById("highlights");
  const playedGames = state.picks.groupStage
    .map((m, idx) => ({ m, idx, f: findFixture(m.homeEn, m.awayEn) }))
    .filter(({ f }) => f?.HomeTeamScore != null && f?.AwayTeamScore != null)
    .sort((a, b) => new Date(b.f.DateUtc) - new Date(a.f.DateUtc));
  if (!playedGames.length) {
    container.innerHTML = `<p class="empty-state">Inga spelade matcher än. Skytteligan och klippen fylls på när matcherna spelats.</p>`;
    return;
  }

  container.innerHTML = `<div class="skel skel-card"></div><div class="skel skel-card"></div>`;
  const groups = [];
  const scorers = new Map(); // name -> { name, team, goals, pens }
  for (const { m, idx, f } of playedGames) {
    try {
      const eid = await getEventId(m.homeEn, m.awayEn, f.DateUtc);
      if (!eid) continue;
      const summary = await getSummary(eid);
      for (const g of extractGoals(summary)) {
        const key = g.scorer + "|" + g.team;
        const rec = scorers.get(key) || { name: g.scorer, team: g.team, goals: 0, pens: 0 };
        rec.goals++;
        if (g.penalty) rec.pens++;
        scorers.set(key, rec);
      }
      const videos = (summary.videos || []).filter((v) => v.links?.source?.href);
      if (videos.length) groups.push({ m, idx, f, videos });
    } catch (e) {
      console.warn("highlight/goal fetch failed for match", idx, e);
    }
  }

  const topScorers = [...scorers.values()].sort(
    (a, b) => b.goals - a.goals || b.pens - a.pens || a.name.localeCompare(b.name, "sv"),
  );

  let skyttHtml = "";
  if (topScorers.length) {
    let rank = 0, prev = null, dr = 0;
    const rows = topScorers.slice(0, 15).map((s) => {
      rank++;
      if (s.goals !== prev) dr = rank;
      prev = s.goals;
      const pen = s.pens ? `<span class="sk-pen">${s.pens} straff</span>` : "";
      return `<li class="sk-row">
        <span class="sk-rank ${dr === 1 ? "lead" : ""}">${dr}</span>
        <span class="sk-flag">${teamLogoHtml(s.team, "sm")}</span>
        <span class="sk-name">${s.name}${pen}</span>
        <span class="sk-goals">${s.goals}</span>
      </li>`;
    }).join("");
    skyttHtml = `<section class="block-inner sk-wrap">
      <div class="section-head"><h2>Skytteliga</h2><span class="section-sub">${topScorers.length} målskyttar</span></div>
      <ol class="sk-list">${rows}</ol>
    </section>`;
  }

  const hlHtml = groups.length
    ? groups
        .map(({ m, idx, f, videos }) => {
          const score = `${f.HomeTeamScore}–${f.AwayTeamScore}`;
          const items = videos
            .map((v) => {
              const src = v.links.source.href;
              const poster = v.thumbnail || "";
              const dur = v.duration ? `${v.duration}s` : "";
              return `<figure class="hl">
                <video class="hl-video" controls preload="none" playsinline poster="${poster}" src="${src}"></video>
                <figcaption class="hl-cap">
                  <span class="hl-title">${v.headline || ""}</span>
                  <span class="hl-dur">${dur}</span>
                </figcaption>
              </figure>`;
            })
            .join("");
          return `<section class="hl-match" data-open-match="${idx}">
            <div class="hl-match-head">
              <span class="hl-match-teams">${teamLogoHtml(m.homeEn, "sm")} ${m.homeSv} ${score} ${m.awaySv} ${teamLogoHtml(m.awayEn, "sm")}</span>
              <span class="hl-match-date">${formatDate(f.DateUtc)}</span>
            </div>
            <div class="hl-grid">${items}</div>
          </section>`;
        })
        .join("")
    : `<p class="empty-state">Inga videoklipp tillgängliga än.</p>`;

  container.innerHTML = `${skyttHtml}<div class="section-head hl-sep"><h2>Höjdpunkter</h2></div>${hlHtml}`;
}

const KO_ROUNDS = [
  { round: 4, label: "Sextondelsfinal", short: "32-lag" },
  { round: 5, label: "Åttondelsfinal", short: "16-lag" },
  { round: 6, label: "Kvartsfinal", short: "Kvart" },
  { round: 7, label: "Semifinal", short: "Semi" },
  { round: 8, label: "Final & Brons", short: "Final" },
];

function isPlaceholderTeam(name) {
  // ESPN/fixturedownload placeholders like "1A", "2B", "3CDFGH", "W57"
  return !state.teams[name] && !state.teams[FD_TO_ESPN[name]];
}

function koTeamHtml(name, side) {
  if (isPlaceholderTeam(name)) {
    const label = /to be announced/i.test(name) ? "TBD" : name;
    return `<span class="ko-team"><span class="ko-ph">${label}</span></span>`;
  }
  return `<span class="ko-team">${teamLogoHtml(name, "sm")}<span class="ko-tn">${name}</span></span>`;
}

function renderKnockout() {
  const list = state.fixtures?.matches || [];
  state.koRound = state.koRound || 4;

  const chips = KO_ROUNDS.map(
    (r) => `<button class="ko-chip ${state.koRound === r.round ? "active" : ""}" data-ko-round="${r.round}">${r.short}</button>`,
  ).join("");

  const meta = KO_ROUNDS.find((r) => r.round === state.koRound);
  const games = list
    .filter((m) => m.RoundNumber === state.koRound)
    .sort((a, b) => new Date(a.DateUtc) - new Date(b.DateUtc));

  const cards = games
    .map((g) => {
      const played = g.HomeTeamScore != null && g.AwayTeamScore != null;
      const hWin = played && g.HomeTeamScore > g.AwayTeamScore;
      const aWin = played && g.AwayTeamScore > g.HomeTeamScore;
      const dateStr = g.DateUtc ? formatDate(g.DateUtc) : "Datum TBD";
      return `<article class="ko-match">
        <div class="ko-row ${hWin ? "win" : ""}">
          ${koTeamHtml(g.HomeTeam)}
          <span class="ko-num">${played ? g.HomeTeamScore : ""}</span>
        </div>
        <div class="ko-row ${aWin ? "win" : ""}">
          ${koTeamHtml(g.AwayTeam)}
          <span class="ko-num">${played ? g.AwayTeamScore : ""}</span>
        </div>
        <div class="ko-foot">${dateStr}${g.Location ? " · " + g.Location : ""}</div>
      </article>`;
    })
    .join("");

  const allPlaceholder = games.length && games.every((g) => isPlaceholderTeam(g.HomeTeam) && isPlaceholderTeam(g.AwayTeam));
  const banner = allPlaceholder
    ? `<p class="ko-intro">Lagen lottas automatiskt från grupptabellerna när gruppspelet är klart (27 juni). Koder som <strong>1A</strong> = vinnare grupp A.</p>`
    : "";

  document.getElementById("knockout").innerHTML = `
    <div class="ko-chips">${chips}</div>
    <h3 class="ko-round-title">${meta?.label || ""}</h3>
    ${banner}
    <div class="ko-grid">${cards || '<p class="hint">Inga matcher i denna omgång än.</p>'}</div>
  `;
}

function heroFlagBg(homeEn, awayEn) {
  const h = teamLogo(homeEn);
  const a = teamLogo(awayEn);
  if (!h && !a) return "";
  return `style="--hero-bg-h:url('${h || ""}'); --hero-bg-a:url('${a || ""}')"`;
}

function renderHero() {
  const el = document.getElementById("hero");
  if (!el) return;
  const all = state.picks.groupStage
    .map((m, idx) => ({ idx, m, f: findFixture(m.homeEn, m.awayEn) }))
    .filter((x) => x.f?.DateUtc);
  const now = Date.now();

  const liveOne = all.find(({ m }) => findLive(m.homeEn, m.awayEn)?.state === "in");
  if (liveOne) {
    const live = findLive(liveOne.m.homeEn, liveOne.m.awayEn);
    el.innerHTML = `<div class="hero-card live-card" data-open-match="${liveOne.idx}" ${heroFlagBg(liveOne.m.homeEn, liveOne.m.awayEn)}>
      <div class="hero-bg"></div>
      <div class="hero-content">
        <div class="hero-tag"><span class="live-dot"></span>Live nu · ${live.clock || ""}</div>
        <div class="hero-teams">
          <div class="hero-side">
            ${teamLogoHtml(liveOne.m.homeEn, "lg")}
            <div class="hero-team-name">${liveOne.m.homeSv}</div>
          </div>
          <div class="hero-vs-score">
            <div class="hero-big-score">${live.homeScore}–${live.awayScore}</div>
          </div>
          <div class="hero-side">
            ${teamLogoHtml(liveOne.m.awayEn, "lg")}
            <div class="hero-team-name">${liveOne.m.awaySv}</div>
          </div>
        </div>
        <div class="hero-sub">${liveOne.f.Location || ""}</div>
      </div>
    </div>`;
    return;
  }

  const next = all
    .filter((x) => new Date(x.f.DateUtc).getTime() > now)
    .sort((a, b) => new Date(a.f.DateUtc) - new Date(b.f.DateUtc))[0];
  if (!next) {
    el.innerHTML = "";
    return;
  }
  const ms = new Date(next.f.DateUtc).getTime() - now;
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const countdown = days > 0 ? `${days}d ${hours % 24}h` : hours > 0 ? `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m` : `${Math.floor(ms / 60_000)} min`;
  el.innerHTML = `<div class="hero-card" data-open-match="${next.idx}" ${heroFlagBg(next.m.homeEn, next.m.awayEn)}>
    <div class="hero-bg"></div>
    <div class="hero-content">
      <div class="hero-tag">Nästa match · om ${countdown}</div>
      <div class="hero-teams">
        <div class="hero-side">
          ${teamLogoHtml(next.m.homeEn, "lg")}
          <div class="hero-team-name">${next.m.homeSv}</div>
        </div>
        <div class="hero-vs-score">
          <div class="hero-vs-txt">vs</div>
          <div class="hero-time">${formatDate(next.f.DateUtc)}</div>
        </div>
        <div class="hero-side">
          ${teamLogoHtml(next.m.awayEn, "lg")}
          <div class="hero-team-name">${next.m.awaySv}</div>
        </div>
      </div>
      <div class="hero-sub">${next.f.Location || ""}</div>
    </div>
  </div>`;
}

function renderPulse() {
  const el = document.getElementById("pulse");
  if (!el) return;
  let played = 0, goals = 0, live = 0;
  for (const f of state.fixtures.matches) {
    if (f.HomeTeamScore != null && f.AwayTeamScore != null) {
      played++;
      goals += Number(f.HomeTeamScore) + Number(f.AwayTeamScore);
    }
  }
  for (const m of state.picks.groupStage) {
    if (findLive(m.homeEn, m.awayEn)?.state === "in") live++;
  }
  const total = state.fixtures.matches.length;
  const avg = played ? (goals / played).toFixed(1) : "0";
  el.innerHTML = `
    <div class="pulse">
      <div class="pulse-cell"><span class="pulse-val">${played}<span class="pulse-tot">/${total}</span></span><span class="pulse-lbl">Spelade</span></div>
      <div class="pulse-cell"><span class="pulse-val">${goals}</span><span class="pulse-lbl">Mål</span></div>
      <div class="pulse-cell"><span class="pulse-val">${avg}</span><span class="pulse-lbl">Snitt/match</span></div>
      <div class="pulse-cell"><span class="pulse-val ${live ? "pulse-live" : ""}">${live}</span><span class="pulse-lbl">Live nu</span></div>
    </div>`;
}

function render() {
  const scores = computeScores();
  renderScoreboard(scores);
  renderHero();
  renderPulse();
  renderMatches();
  if (state.tab === "groups") renderGroups();
  if (state.tab === "sweden") renderSweden();
  renderUpdated();
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".navbtn");
  if (tab) { switchTab(tab.dataset.tab); return; }

  const koChip = e.target.closest("[data-ko-round]");
  if (koChip) { state.koRound = Number(koChip.dataset.koRound); renderKnockout(); return; }

  const filterBtn = e.target.closest(".filter");
  if (filterBtn) {
    document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
    filterBtn.classList.add("active");
    state.filter = filterBtn.dataset.filter;
    renderMatches();
    return;
  }

  const playerRow = e.target.closest("[data-player]");
  if (playerRow && !e.target.closest(".navbtn")) { openPlayer(playerRow.dataset.player); return; }

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
  const dlg = document.getElementById(id);
  dlg.addEventListener("click", (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) dlg.close();
  });
  dlg.addEventListener("close", () => document.documentElement.classList.remove("modal-open"));
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

function detailNewsHtml(summary, m) {
  const articles = summary.news?.articles || [];
  if (!articles.length) return "";
  const want = new Set([m.homeEn, m.awayEn].filter(Boolean).map((s) => s.toLowerCase()));
  const isRelevant = (a) => {
    const cats = a.categories || [];
    return cats.some(
      (c) => c.type === "team" && c.description && want.has(c.description.toLowerCase()),
    );
  };
  const filtered = articles.filter(isRelevant);
  if (!filtered.length) return "";
  const items = filtered
    .slice(0, 5)
    .map(
      (a) => `<li>
        <a href="${a.links?.web?.href || "#"}" target="_blank" rel="noopener">${a.headline}</a>
        ${a.description ? `<span class="news-desc">${a.description}</span>` : ""}
      </li>`,
    );
  return `<section class="detail-section">
    <h3>Nyheter</h3>
    <ul class="news-list">${items.join("")}</ul>
  </section>`;
}

function detailArticleHtml(summary) {
  const a = summary.article;
  if (!a?.headline) return "";
  const img = a.images?.[0]?.url || a.images?.[0]?.href || "";
  const link = a.links?.web?.href || a.links?.mobile?.href || "";
  return `<section class="detail-section">
    <h3>Analys</h3>
    <article class="analysis-card">
      ${img ? `<img class="analysis-img" src="${img}" alt="" loading="lazy">` : ""}
      <div class="analysis-body">
        <h4 class="analysis-headline">${a.headline}</h4>
        ${a.description ? `<p class="analysis-desc">${a.description}</p>` : ""}
        ${link ? `<a class="analysis-link" href="${link}" target="_blank" rel="noopener">Läs hela analysen →</a>` : ""}
      </div>
    </article>
  </section>`;
}

function detailHighlightsHtml(summary) {
  const videos = (summary.videos || []).filter((v) => v.links?.source?.href);
  if (!videos.length) return "";
  const items = videos
    .slice(0, 6)
    .map((v) => {
      const src = v.links.source.href;
      const poster = v.thumbnail || "";
      const dur = v.duration ? `${v.duration}s` : "";
      return `<figure class="hl">
        <video class="hl-video" controls preload="none" playsinline poster="${poster}" src="${src}"></video>
        <figcaption class="hl-cap">
          <span class="hl-title">${v.headline || ""}</span>
          <span class="hl-dur">${dur}</span>
        </figcaption>
      </figure>`;
    })
    .join("");
  return `<section class="detail-section">
    <h3>Mål och höjdpunkter</h3>
    <div class="hl-grid">${items}</div>
  </section>`;
}

function detailVenueHtml(summary) {
  const v = summary.gameInfo?.venue;
  if (!v) return "";
  const where = [v.fullName, v.address?.city, v.address?.country].filter(Boolean).join(", ");
  return `<p class="detail-venue">📍 ${where}</p>`;
}

function collapsible(title, innerHtml) {
  if (!innerHtml?.trim()) return "";
  const stripped = innerHtml.replace(/<section class="detail-section">|<\/section>$/g, "");
  const idx = stripped.indexOf("<h3>");
  const body = idx >= 0 ? stripped.replace(/<h3>[\s\S]*?<\/h3>/, "") : stripped;
  return `<details class="collapsible">
    <summary><span class="col-title">${title}</span><span class="col-chevron">▾</span></summary>
    <div class="col-body">${body}</div>
  </details>`;
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
    <div id="detail-extra"><div class="skel skel-line"></div><div class="skel skel-line"></div></div>
  `;
  document.documentElement.classList.add("modal-open");
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
      ${detailHighlightsHtml(summary)}
      ${collapsible("Analys", detailArticleHtml(summary))}
      ${collapsible("Head-to-head", detailH2HHtml(summary))}
      ${collapsible("Händelser", detailEventsHtml(summary))}
      ${collapsible("Nyheter", detailNewsHtml(summary, m))}
      ${detailVenueHtml(summary)}
    `;
  } catch (err) {
    document.getElementById("detail-extra").innerHTML = `<p class="detail-empty">Kunde inte hämta detaljer (${err.message}).</p>`;
  }
}

function impliedProbs(oddsObj) {
  if (!oddsObj) return null;
  const h = americanToDecimal(oddsObj.homeTeamOdds?.moneyLine);
  const d = americanToDecimal(oddsObj.drawOdds?.moneyLine);
  const a = americanToDecimal(oddsObj.awayTeamOdds?.moneyLine);
  if (h == null || d == null || a == null) return null;
  const inv = [1 / h, 1 / d, 1 / a];
  const sum = inv.reduce((x, y) => x + y, 0);
  return { home: inv[0] / sum, draw: inv[1] / sum, away: inv[2] / sum };
}

function detailProbabilityHtml(oddsObj, m) {
  const p = impliedProbs(oddsObj);
  if (!p) return "";
  const pct = [p.home, p.draw, p.away].map((x) => Math.round(x * 100));
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
