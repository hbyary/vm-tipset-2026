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
function toEspnName(fdName) {
  return FD_TO_ESPN[fdName] || fdName;
}
function normTeam(s) {
  return (s || "").toLowerCase().replace(/[''`]/g, "'").replace(/\s+/g, " ").trim();
}
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
  backfillResults();
  loadKnockoutResults();
}

async function refresh() {
  try {
    await load();
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

// fixturedownload sometimes lags on results — backfill final scores from ESPN (more reliable)
const _scoreboardCache = new Map(); // ymd -> { at, map }
async function espnResultsForDate(ymd) {
  const cached = _scoreboardCache.get(ymd);
  if (cached && Date.now() - cached.at < 45_000) return cached.map;
  const map = {};
  try {
    const r = await fetch(`${ESPN_SCOREBOARD}?dates=${ymd}`, { cache: "no-store" });
    const j = await r.json();
    for (const e of j.events || []) {
      if (e.status?.type?.state !== "post") continue;
      const c = e.competitions?.[0];
      const h = c?.competitors?.find((x) => x.homeAway === "home");
      const a = c?.competitors?.find((x) => x.homeAway === "away");
      if (!h || !a) continue;
      const detail = e.status?.type?.detail || "";
      const penH = h.shootoutScore != null ? Number(h.shootoutScore) : null;
      const penA = a.shootoutScore != null ? Number(a.shootoutScore) : null;
      const hasPens = penH != null && penA != null && (penH > 0 || penA > 0);
      map[normTeam(h.team.displayName) + "|" + normTeam(a.team.displayName)] = {
        hs: Number(h.score),
        as: Number(a.score),
        penH,
        penA,
        isPens: hasPens || /pen/i.test(detail),
        isAet: /aet|extra|et\b/i.test(detail) && !/pen/i.test(detail),
        winnerHome: h.winner === true,
        winnerAway: a.winner === true,
      };
    }
  } catch (e) {
    console.warn("espn results fetch failed", ymd, e);
  }
  _scoreboardCache.set(ymd, { at: Date.now(), map });
  return map;
}

async function backfillResults() {
  const list = state.fixtures?.matches || [];
  const now = Date.now();
  const stale = list.filter(
    (f) =>
      f.DateUtc &&
      new Date(f.DateUtc).getTime() < now && // already kicked off
      (f.HomeTeamScore == null || f.AwayTeamScore == null),
  );
  if (!stale.length) return;
  // ESPN buckets matches by US-timezone date, so a match at e.g. 02:00 UTC lands
  // on the previous ESPN day. Query ±1 day around each stale date and match by
  // team pair (each pairing is unique), independent of which day-bucket it's in.
  const dates = new Set();
  for (const f of stale) {
    const base = new Date(f.DateUtc.slice(0, 10) + "T12:00:00Z");
    for (const off of [-1, 0, 1]) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + off);
      dates.add(d.toISOString().slice(0, 10).replace(/-/g, ""));
    }
  }
  const merged = {};
  for (const ymd of dates) Object.assign(merged, await espnResultsForDate(ymd));

  let patched = 0;
  for (const f of stale) {
    const key = normTeam(toEspnName(f.HomeTeam)) + "|" + normTeam(toEspnName(f.AwayTeam));
    const res = merged[key];
    if (res && Number.isFinite(res.hs) && Number.isFinite(res.as)) {
      f.HomeTeamScore = res.hs;
      f.AwayTeamScore = res.as;
      f._backfilled = true;
      patched++;
    }
  }
  if (patched) render();
}

// Knockout results (incl. extra time + penalties) keyed by team pair.
const koResultStore = {}; // pairKey -> full ESPN record
async function loadKnockoutResults() {
  const list = (state.fixtures?.matches || []).filter(
    (m) => m.RoundNumber >= 4 && isRealTeam(m.HomeTeam) && isRealTeam(m.AwayTeam) && m.DateUtc,
  );
  if (!list.length) return;
  const dates = new Set();
  for (const m of list) {
    const base = new Date(m.DateUtc.slice(0, 10) + "T12:00:00Z");
    for (const off of [-1, 0, 1]) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + off);
      dates.add(d.toISOString().slice(0, 10).replace(/-/g, ""));
    }
  }
  const merged = {};
  for (const ymd of dates) Object.assign(merged, await espnResultsForDate(ymd));
  let changed = false;
  for (const m of list) {
    const key = normTeam(toEspnName(m.HomeTeam)) + "|" + normTeam(toEspnName(m.AwayTeam));
    if (merged[key]) {
      koResultStore[key] = merged[key];
      changed = true;
    }
  }
  if (changed && (state.tab === "knockout" || state.tab === "home")) render();
}

function isRealTeam(name) {
  return !!name && !/to be announced/i.test(name) && !/^\d/.test(name) && !/^W\d/.test(name);
}
function koInfo(homeEn, awayEn) {
  return koResultStore[normTeam(toEspnName(homeEn)) + "|" + normTeam(toEspnName(awayEn))] || null;
}

// --- Knockout progression / Title race -------------------------------------
function koLoserOf(m) {
  if (!isRealTeam(m.HomeTeam) || !isRealTeam(m.AwayTeam)) return null;
  const info = koInfo(m.HomeTeam, m.AwayTeam);
  if (info) {
    if (info.winnerHome) return m.AwayTeam;
    if (info.winnerAway) return m.HomeTeam;
    if (info.hs !== info.as) return info.hs > info.as ? m.AwayTeam : m.HomeTeam;
    if (info.penH != null && info.penA != null && info.penH !== info.penA)
      return info.penH > info.penA ? m.AwayTeam : m.HomeTeam;
  }
  if (m.HomeTeamScore != null && m.AwayTeamScore != null && m.HomeTeamScore !== m.AwayTeamScore)
    return m.HomeTeamScore > m.AwayTeamScore ? m.AwayTeam : m.HomeTeam;
  // draw with no shootout data → infer loser from who appears in the next round
  const next = new Set(
    (state.fixtures?.matches || [])
      .filter((x) => x.RoundNumber === m.RoundNumber + 1)
      .flatMap((x) => [x.HomeTeam, x.AwayTeam])
      .filter(isRealTeam)
      .map((t) => normTeam(toEspnName(t))),
  );
  if (next.size) {
    const hIn = next.has(normTeam(toEspnName(m.HomeTeam)));
    const aIn = next.has(normTeam(toEspnName(m.AwayTeam)));
    if (hIn && !aIn) return m.AwayTeam;
    if (aIn && !hIn) return m.HomeTeam;
  }
  return null; // undecided
}

function knockoutState() {
  const ms = (state.fixtures?.matches || []).filter((m) => m.RoundNumber >= 4);
  const r32 = ms.filter((m) => m.RoundNumber === 4);
  const allTeams = new Set(r32.flatMap((m) => [m.HomeTeam, m.AwayTeam]).filter(isRealTeam).map((t) => normTeam(toEspnName(t))));
  const eliminated = new Set();
  for (const m of ms) {
    const loser = koLoserOf(m);
    if (loser) eliminated.add(normTeam(toEspnName(loser)));
  }
  // final = latest-dated round-8 match
  const finals = ms.filter((m) => m.RoundNumber === 8 && m.DateUtc).sort((a, b) => new Date(b.DateUtc) - new Date(a.DateUtc));
  const finalMatch = finals[0] || null;
  let champion = null; // normalized english
  if (finalMatch) {
    const loser = koLoserOf(finalMatch);
    if (loser && isRealTeam(finalMatch.HomeTeam) && isRealTeam(finalMatch.AwayTeam)) {
      const ln = normTeam(toEspnName(loser));
      champion = [finalMatch.HomeTeam, finalMatch.AwayTeam].map((t) => normTeam(toEspnName(t))).find((t) => t !== ln) || null;
    }
  }
  const alive = [...allTeams].filter((t) => !eliminated.has(t));
  return { alive, eliminated, champion, finalMatch };
}

function titleRace() {
  const players = state.picks.players;
  const ks = knockoutState();
  // current group points (no winner bonus)
  const base = {};
  for (const p of players) base[p] = 0;
  for (const m of state.picks.groupStage) {
    const { home, away } = resolvedScores(m);
    const o = outcomeFromScores(home, away);
    if (o == null) continue;
    for (const p of players) if (m.picks[p] === o) base[p]++;
  }
  // tiebreaker distance (lower = better) from Sweden GF/GA
  let sgf = 0, sga = 0;
  for (const m of state.picks.groupStage) {
    if (m.homeEn !== "Sweden" && m.awayEn !== "Sweden") continue;
    const { home, away } = resolvedScores(m);
    if (home == null) continue;
    const isHome = m.homeEn === "Sweden";
    sgf += isHome ? home : away;
    sga += isHome ? away : home;
  }
  const gg = state.picks.goalGuesses || {};
  const dist = {};
  for (const p of players) dist[p] = gg[p] ? Math.abs(gg[p].for - sgf) + Math.abs(gg[p].against - sga) : Infinity;

  // map each player's WC winner pick to a normalized english team
  const pickEn = {};
  for (const p of players) {
    const sv = state.picks.winnerPicks[p] || "";
    pickEn[p] = sv ? normTeam(toEspnName(state.picks.mapping[sv] || sv)) : null;
  }

  const champ = (finalPts) =>
    players
      .slice()
      .sort((a, b) => finalPts[b] - finalPts[a] || dist[a] - dist[b] || a.localeCompare(b, "sv"))[0];

  // possible WC winners still in play (or the decided champion)
  const possibleWinners = ks.champion ? [ks.champion] : ks.alive;
  const outcomeByTeam = {}; // team -> pool champion
  for (const t of possibleWinners) {
    const fp = {};
    for (const p of players) fp[p] = base[p] + (pickEn[p] === t ? 2 : 0);
    outcomeByTeam[t] = champ(fp);
  }
  const distinctChamps = [...new Set(Object.values(outcomeByTeam))];

  const ranked = players.map((p) => ({ p, pts: base[p], dist: dist[p], pickSv: state.picks.winnerPicks[p] || "", pickEn: pickEn[p] }))
    .sort((a, b) => b.pts - a.pts || a.dist - b.dist);

  return { base, dist, pickEn, ranked, ks, sgf, sga, possibleWinners, outcomeByTeam, distinctChamps, champ };
}

function renderTitleRace() {
  const el = document.getElementById("titlerace");
  if (!el) return;
  const tr = titleRace();
  const leader = tr.ranked[0];
  const second = tr.ranked[1];
  const decided = tr.distinctChamps.length === 1;
  const lines = [];

  // mini standings (top 4)
  const standings = tr.ranked
    .slice(0, 4)
    .map((r, i) => `<div class="tr-stand"><span class="tr-pos">${i + 1}</span><span class="tr-nm">${r.p}</span><span class="tr-wc">${r.pickSv || "–"}</span><span class="tr-pt">${r.pts}p</span><span class="tr-tb">±${r.dist === Infinity ? "–" : r.dist}</span></div>`)
    .join("");

  if (decided) {
    const champ = tr.distinctChamps[0];
    lines.push({ icon: "🏆", cls: "tr-win", t: `<strong>${champ} vinner tipset!</strong> Matematiskt avgjort — ingen kan längre gå om.` });
  } else {
    const defaultChamp = tr.champ(tr.base);
    lines.push({ icon: "🥇", t: `<strong>${leader.p}</strong> leder med ${leader.pts} p (särskiljare ±${leader.dist}). Vinner ingen av jagarnas VM-lag står ${leader.p} som segrare.` });

    // who can still flip it, and how
    for (const r of tr.ranked) {
      if (r.p === leader.p) continue;
      if (!r.pickEn) continue;
      const alive = tr.possibleWinners.includes(r.pickEn);
      const championIfPickWins = tr.outcomeByTeam[r.pickEn];
      const canTie = r.pts + 2 >= leader.pts;
      if (championIfPickWins === r.p) {
        lines.push({
          icon: "🎯",
          cls: "tr-flip",
          t: `<strong>${r.p} vinner OM ${r.pickSv} vinner VM</strong> → ${r.pts}+2 = ${r.pts + 2} p och tar särskiljaren (±${r.dist} mot ±${leader.dist}).${alive ? "" : ` Men ${r.pickSv} är redan utslaget — borta.`}`,
        });
      } else if (canTie && alive) {
        // close enough to tie but loses tiebreaker / still short
        const wouldBe = r.pts + 2;
        const reason = wouldBe < leader.pts
          ? `når bara ${wouldBe} p`
          : `når ${wouldBe} p men förlorar särskiljaren mot ${leader.p} (±${r.dist} mot ±${leader.dist})`;
        lines.push({ icon: "🚫", t: `<strong>${r.p} kan inte vinna</strong>: även om ${r.pickSv} vinner VM ${reason}.` });
      }
    }

    // pivot watch
    const flipTeams = tr.possibleWinners.filter((t) => tr.outcomeByTeam[t] !== defaultChamp);
    if (flipTeams.length) {
      const flipNames = [...new Set(flipTeams.map((t) => {
        const r = tr.ranked.find((x) => x.pickEn === t);
        return r ? r.pickSv : t;
      }))];
      lines.push({ icon: "👀", cls: "tr-watch", t: `Att hålla koll på: <strong>${flipNames.join(", ")}</strong>. Åker ${flipNames.length === 1 ? "laget" : "alla dessa"} ut ur VM är ${defaultChamp} klar mästare.` });
    }
  }

  el.innerHTML = `
    <div class="section-head"><h2>Titelstriden</h2><span class="section-sub">${decided ? "Avgjort" : "Slutspel pågår"}</span></div>
    <div class="tr-card ${decided ? "tr-decided" : ""}">
      <div class="tr-lines">${lines.map((l) => `<div class="insight ${l.cls || ""}"><span class="insight-ico">${l.icon}</span><span class="insight-txt">${l.t}</span></div>`).join("")}</div>
      <div class="tr-standings">${standings}</div>
      <p class="tr-foot">+2 bonus för rätt VM-vinnare · särskiljare = närmast Sveriges mål (${tr.sgf}–${tr.sga}), lägst ± vinner</p>
    </div>`;
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
      map[liveKey(home.team.displayName, away.team.displayName)] = {
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

const ESPN_ALIAS = Object.fromEntries(
  Object.entries(FD_TO_ESPN).map(([fd, espn]) => [espn, fd]),
);
function espnTeamName(displayName) {
  return ESPN_ALIAS[displayName] || displayName;
}

// Canonical pairing key — normalised ESPN names so FD-sourced (picks/fixtures)
// and ESPN-sourced (scoreboard) names always match, incl. the 8 aliased teams.
function pairKey(home, away) {
  return normTeam(toEspnName(home)) + "|" + normTeam(toEspnName(away));
}
function liveKey(homeEn, awayEn) {
  return pairKey(homeEn, awayEn);
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

  const cutoff = Date.now() - 24 * 3600_000;
  const isOld = (r) => r.played && !r.isLive && r.f?.DateUtc && new Date(r.f.DateUtc).getTime() < cutoff;
  const older = filtered.filter(isOld);
  const current = filtered.filter((r) => !isOld(r));

  const renderList = (list) => {
    let lastDay = null;
    return list
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
  };

  let html = renderList(current);
  if (older.length && current.length) {
    // newest-first inside the collapsed history
    const olderHtml = renderList([...older].reverse());
    html += `<details class="older-wrap"${state.filter === "played" ? " open" : ""}>
      <summary><span class="col-title">Tidigare matcher</span><span class="older-count">${older.length}</span><span class="col-chevron">▾</span></summary>
      <div class="older-body">${olderHtml}</div>
    </details>`;
  } else if (older.length) {
    // no current matches (group stage over) → render history flat, newest first
    html += renderList([...older].reverse());
  }

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
      // collapsed header summary: top 2 teams as a teaser
      const leaders = rows
        .slice(0, 2)
        .map((r) => `${teamLogoHtml(r.name, "sm")} <span class="gc-lead-name">${r.sv}</span>`)
        .join('<span class="gc-sep">·</span>');
      const playedN = state.picks.groupStage.filter((m) => findFixture(m.homeEn, m.awayEn)?.Group === grp).filter((m) => { const { home, away } = resolvedScores(m); return home != null && away != null; }).length;
      const open = grp === "Group F" ? " open" : ""; // Sweden's group expanded by default
      return `<details class="group-card"${open}>
        <summary class="gc-summary">
          <span class="gc-grp">${grp.replace("Group ", "Grupp ")}</span>
          <span class="gc-leaders">${leaders}</span>
          <span class="gc-meta">${playedN}/6</span>
          <span class="col-chevron">▾</span>
        </summary>
        <div class="gc-body">
          <table class="group-table">
            <thead><tr><th></th><th>Lag</th><th>S</th><th>V</th><th>O</th><th>F</th><th>Mål</th><th>P</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
          <div class="group-matches">${grpMatches}</div>
        </div>
      </details>`;
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

function sheetHeader(target) {
  // Sticky header lives inside the scrolling sheet (page content), so the close
  // control is always in the visible band between the browser toolbars.
  return `<div class="sheet-head"><span class="sheet-grab"></span><button class="detail-close" data-close="${target}" aria-label="Stäng">✕</button></div>`;
}

function openScorer(key) {
  const det = scorerGoals.get(key);
  if (!det) return;
  const goals = det.goals.slice().sort((a, b) => parseInt(a.clock) - parseInt(b.clock));
  const items = goals
    .map(
      (g) => `<li class="sg-row">
        <span class="sg-clock">${g.clock || "?"}</span>
        <span class="sg-match">${g.matchSv}</span>
        ${g.penalty ? '<span class="sg-pen">straff</span>' : ""}
      </li>`,
    )
    .join("");
  const pens = goals.filter((g) => g.penalty).length;
  document.getElementById("player-body").innerHTML = `
    ${sheetHeader("player")}
    <header class="detail-header">
      <div class="player-hero">
        ${teamLogoHtml(det.team, "lg") || `<span class="avatar lg" style="${playerPalette(det.name)}">${playerInitial(det.name)}</span>`}
        <div>
          <div class="detail-teams">${det.name}</div>
          <div class="detail-meta">
            <span class="detail-score">${goals.length} mål</span>
            <span class="player-stats">${det.team}${pens ? ` · ${pens} på straff` : ""}</span>
          </div>
        </div>
      </div>
    </header>
    <section class="detail-section">
      <h3>Var målen gjordes</h3>
      <ul class="sg-list">${items}</ul>
    </section>
  `;
  document.documentElement.classList.add("modal-open");
  document.getElementById("player").showModal();
}

function winPath(name) {
  const scores = computeScores();
  const me = scores[name].pts;
  const players = state.picks.players;
  const ranked = players
    .map((p) => ({ p, pts: scores[p].pts }))
    .sort((a, b) => b.pts - a.pts);
  const leaderPts = ranked[0].pts;
  const isLeader = me === leaderPts;

  // undecided group matches (no result yet)
  const undecided = state.picks.groupStage.filter(
    (m) => outcomeFromScores(resolvedScores(m).home, resolvedScores(m).away) == null,
  );
  const winnerOpen = !state.picks.actualWinner;
  const myWinner = state.picks.winnerPicks[name];

  // remaining points THIS player can still earn (where they have a pick)
  const myRemain = undecided.filter((m) => m.picks[name]).length;
  const maxMe = me + myRemain + (winnerOpen && myWinner ? 2 : 0);

  // swing analysis vs a rival: only matches where picks DIFFER can move the gap
  function swingVs(rival) {
    let differ = 0;
    const keyMatches = [];
    for (const m of undecided) {
      const a = m.picks[name];
      const b = m.picks[rival];
      if (a && b && a !== b) {
        differ++;
        keyMatches.push(m);
      }
    }
    let winnerSwing = 0;
    if (winnerOpen && myWinner && state.picks.winnerPicks[rival] && myWinner !== state.picks.winnerPicks[rival]) winnerSwing = 2;
    return { differ, winnerSwing, maxSwing: differ + winnerSwing, keyMatches };
  }

  const lines = [];
  const totalPicks = state.picks.groupStage.filter((m) => m.picks[name]).length;
  if (totalPicks === 0) {
    lines.push({ icon: "🫥", t: `${name} har inga tips registrerade — står utanför poängjakten. Lägg in tipsen för att vara med!` });
    return { lines, maxMe };
  }
  if (isLeader) {
    // who can still catch the leader?
    const chasers = players
      .filter((p) => p !== name)
      .map((p) => {
        const rem = undecided.filter((m) => m.picks[p]).length;
        const max = scores[p].pts + rem + (winnerOpen && state.picks.winnerPicks[p] ? 2 : 0);
        return { p, pts: scores[p].pts, max };
      })
      .filter((c) => c.max >= me)
      .sort((a, b) => b.max - a.max);
    if (!undecided.length) {
      lines.push({ icon: "🏆", t: `Tävlingen är avgjord — ${name} vinner med ${me} p!` });
    } else if (!chasers.length) {
      lines.push({ icon: "🏆", t: `Matematiskt klar segrare — ingen kan längre nå ${me} p. Grattis!` });
    } else {
      const names = chasers.slice(0, 3).map((c) => `${c.p} (kan nå ${c.max})`).join(", ");
      lines.push({ icon: "👑", t: `Leder med ${me} p. ${chasers.length} kan teoretiskt gå om: ${names}.` });
      const top = chasers[0];
      const sw = swingVs(top.p);
      lines.push({
        icon: "🛡️",
        t: `Mot främsta utmanaren ${top.p}: ${sw.differ} kvarvarande matcher där ni tippat olika${sw.winnerSwing ? " + VM-vinnaren" : ""}. Håller du jämna steg där är titeln din.`,
      });
    }
    return { lines, maxMe };
  }

  // chaser perspective vs the leader
  const leaderName = ranked[0].p;
  const gap = leaderPts - me;
  const sw = swingVs(leaderName);
  lines.push({ icon: "📊", t: `${gap} p bakom ledaren ${leaderName}. Du kan som mest nå ${maxMe} p.` });

  if (sw.maxSwing < gap) {
    lines.push({
      icon: "⛔",
      t: `Tufft: bara ${sw.differ} kvarvarande matcher där du och ${leaderName} tippat olika${sw.winnerSwing ? " (+ olika VM-vinnare)" : ""} — för få för att hämta in ${gap} p även om allt går din väg. Identiska tips i övriga matcher ändrar inget inbördes.`,
    });
  } else {
    const need = Math.ceil((gap + 1) / 1);
    lines.push({
      icon: "🎯",
      t: `Klättringen sker bara i de ${sw.differ} matcher där ni tippat olika — du måste vinna minst ${Math.min(sw.differ, gap + (sw.winnerSwing ? 0 : 1))} av dem (och hoppas ${leaderName} missar dem)${sw.winnerSwing ? ", eller pricka VM-vinnaren när hen inte gör det" : ""}.`,
    });
  }
  if (sw.keyMatches.length) {
    const km = sw.keyMatches
      .slice(0, 3)
      .map((m) => `${m.homeSv}–${m.awaySv} (du ${m.picks[name]}, ${leaderName} ${m.picks[leaderName]})`)
      .join("; ");
    lines.push({ icon: "🔑", t: `Nyckelmatcher: ${km}.` });
  }
  return { lines, maxMe };
}

function openPlayer(name) {
  const st = playerStats(name);
  const ix = playerInsights(name);
  const narr = playerNarrative(ix);
  const path = winPath(name);
  const pathCards = path.lines
    .map((n) => `<div class="insight"><span class="insight-ico">${n.icon}</span><span class="insight-txt">${n.t}</span></div>`)
    .join("");

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
    ${sheetHeader("player")}
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
      <h3>Vägen till segern</h3>
      <div class="insights">${pathCards}</div>
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

// --- Sweden goals tiebreaker (Mål för / Mål mot guesses) ---
function swedenGoalRace(base) {
  const gg = state.picks.goalGuesses || {};
  const rows = Object.entries(gg)
    .map(([p, g]) => ({
      p,
      gFor: g.for,
      gAgainst: g.against,
      dist: Math.abs(g.for - base.gf) + Math.abs(g.against - base.ga),
    }))
    .sort((a, b) => a.dist - b.dist || a.p.localeCompare(b.p, "sv"));
  return { rows, allPlayed: base.played === base.games.length };
}

// --- Group F simulation for qualification probabilities ---
function matchProbHeuristic(a, b) {
  const ppg = (r) => (r && r.p ? r.pts / r.p : 1);
  const gdpg = (r) => (r && r.p ? (r.gf - r.ga) / r.p : 0);
  const s = (r) => ppg(r) + 0.3 * gdpg(r);
  const diff = s(a) - s(b) + 0.25; // small home edge
  const pHome = 1 / (1 + Math.exp(-diff));
  const draw = 0.26;
  return { h: (1 - draw) * pHome, d: draw, a: (1 - draw) * (1 - pHome) };
}

async function groupFmatchProbs() {
  const rows = computeGroupTables()["Group F"] || [];
  const rowByEn = (en) => rows.find((r) => normTeam(r.name) === normTeam(en));
  const list = state.fixtures.matches.filter(
    (m) => m.Group === "Group F" && m.RoundNumber <= 3 && (m.HomeTeamScore == null || m.AwayTeamScore == null),
  );
  const out = [];
  for (const m of list) {
    let prob = null;
    try {
      const eid = await getEventId(m.HomeTeam, m.AwayTeam, m.DateUtc);
      if (eid) {
        const s = await getSummary(eid);
        const pr = impliedProbs(s.pickcenter?.[0] || s.odds?.[0]);
        if (pr) prob = { h: pr.home, d: pr.draw, a: pr.away };
      }
    } catch (e) {
      /* ignore */
    }
    if (!prob) prob = matchProbHeuristic(rowByEn(m.HomeTeam), rowByEn(m.AwayTeam));
    out.push({ home: m.HomeTeam, away: m.AwayTeam, prob });
  }
  return out;
}

function simulateGroupF(probMatches) {
  const base = (computeGroupTables()["Group F"] || []).map((r) => ({ name: r.name, pts: r.pts, gf: r.gf, ga: r.ga }));
  if (!base.length) return null;
  const teams = base.map((r) => r.name);
  const k = probMatches.length;
  const sweden = [0, 0, 0, 0];
  const combos = Math.pow(3, k);
  for (let mask = 0; mask < combos; mask++) {
    let prob = 1;
    const st = {};
    base.forEach((r) => (st[r.name] = { pts: r.pts, gf: r.gf, ga: r.ga }));
    let x = mask;
    for (let i = 0; i < k; i++) {
      const o = x % 3;
      x = Math.floor(x / 3);
      const pm = probMatches[i];
      prob *= o === 0 ? pm.prob.h : o === 1 ? pm.prob.d : pm.prob.a;
      const H = st[pm.home], A = st[pm.away];
      if (!H || !A) continue;
      if (o === 0) { H.pts += 3; H.gf += 1; A.ga += 1; }
      else if (o === 1) { H.pts += 1; A.pts += 1; H.gf += 1; H.ga += 1; A.gf += 1; A.ga += 1; }
      else { A.pts += 3; A.gf += 1; H.ga += 1; }
    }
    const ranked = teams.slice().sort(
      (a, b) =>
        st[b].pts - st[a].pts ||
        st[b].gf - st[b].ga - (st[a].gf - st[a].ga) ||
        st[b].gf - st[a].gf ||
        a.localeCompare(b),
    );
    const r = ranked.indexOf("Sweden");
    if (r >= 0 && r < 4) sweden[r] += prob;
  }
  return sweden; // [p1, p2, p3, p4]
}

// --- R32 path: who Sweden meets depending on finishing position ---
function slotLabel(slot) {
  if (!slot) return "okänd motståndare";
  if (/^1[A-L]$/.test(slot)) return `vinnaren av grupp ${slot[1]}`;
  if (/^2[A-L]$/.test(slot)) return `tvåan i grupp ${slot[1]}`;
  if (/^3/.test(slot)) return `en av de bästa treorna (${slot.slice(1).split("").join("/")})`;
  if (state.teams[slot] || state.teams[FD_TO_ESPN[slot]]) return slot;
  return slot;
}
function swedenR32Path() {
  const r32 = state.fixtures.matches.filter((m) => m.RoundNumber === 4);
  const find = (slot) => {
    for (const m of r32) {
      if (m.HomeTeam === slot) return { opp: m.AwayTeam, m };
      if (m.AwayTeam === slot) return { opp: m.HomeTeam, m };
    }
    return null;
  };
  const thirdMatch = r32.find((m) => /^3/.test(m.HomeTeam) && m.HomeTeam.includes("F")) || r32.find((m) => /^3/.test(m.AwayTeam) && m.AwayTeam.includes("F"));
  let third = null;
  if (thirdMatch) {
    const opp = /^3/.test(thirdMatch.HomeTeam) && thirdMatch.HomeTeam.includes("F") ? thirdMatch.AwayTeam : thirdMatch.HomeTeam;
    third = { opp, m: thirdMatch };
  }
  return { first: find("1F"), second: find("2F"), third };
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

  // Goals tiebreaker (synchronous, from baked guesses)
  const race = swedenGoalRace(base);
  const raceRows = race.rows
    .map((r, i) => `<li class="gr-row ${i === 0 ? "gr-lead" : ""}">
      <span class="gr-rank">${i + 1}</span>
      <span class="gr-avatar" style="${playerPalette(r.p)}">${playerInitial(r.p)}</span>
      <span class="gr-name">${r.p}</span>
      <span class="gr-guess">${r.gFor}–${r.gAgainst}</span>
      <span class="gr-dist">${r.dist === 0 ? "🎯 prick" : "±" + r.dist}</span>
    </li>`)
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
      <h3>Avancemang — sannolikheter</h3>
      <div id="se-scenarios"><div class="skel skel-line"></div></div>
    </section>
    <section class="detail-section">
      <h3>Slutspelsväg</h3>
      <div id="se-path"><div class="skel skel-line"></div></div>
    </section>
    <section class="detail-section">
      <h3>Måltipset · särskiljare</h3>
      <p class="gr-actual">Sverige <strong>${base.gf}–${base.ga}</strong> ${race.allPlayed ? "(slutresultat)" : `efter ${base.played} av ${base.games.length} matcher — preliminärt`}. Närmast i mål för + mål mot vinner särskiljaren.</p>
      <ol class="gr-list">${raceRows}</ol>
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

  // Async enrich: odds-based market + news + simulation
  const market = await swedenMarket(base.remaining);
  const narr = swedenNarrative(base, market);
  const insEl = document.getElementById("se-insights");
  if (insEl) {
    insEl.innerHTML = narr
      .map((n) => `<div class="insight"><span class="insight-ico">${n.icon}</span><span class="insight-txt">${n.t}</span></div>`)
      .join("");
  }

  // Scenarios / probabilities
  const scEl = document.getElementById("se-scenarios");
  if (scEl) {
    const probMatches = await groupFmatchProbs();
    const sim = simulateGroupF(probMatches);
    if (sim) {
      const pct = sim.map((x) => Math.round(x * 100));
      const advance = pct[0] + pct[1];
      const bar = (lbl, v, col) =>
        `<div class="prob-row"><span class="prob-lbl">${lbl}</span><span class="prob-bar"><span class="prob-fill" style="width:${v}%;background:${col}"></span></span><span class="prob-pct">${v}%</span></div>`;
      scEl.innerHTML = `
        <div class="prob-rows">
          ${bar("Vinner gruppen", pct[0], "linear-gradient(90deg,#facc15,#f59e0b)")}
          ${bar("Tvåa", pct[1], "linear-gradient(90deg,#34d399,#10b981)")}
          ${bar("Trea (kval)", pct[2], "linear-gradient(90deg,#60a5fa,#3b82f6)")}
          ${bar("Utslagen", pct[3], "linear-gradient(90deg,#f87171,#ef4444)")}
        </div>
        <p class="gr-actual">Direktavancemang (topp 2): <strong>${advance}%</strong>. Som trea krävs en plats bland de 8 bästa treorna av 12. ${probMatches.length === 0 ? "Gruppen är färdigspelad." : `Baserat på ${probMatches.length} kvarvarande gruppmatch${probMatches.length > 1 ? "er" : ""} (oddsmarknad + form).`}</p>`;
    } else {
      scEl.innerHTML = `<p class="gr-actual">Kan inte beräkna scenarier ännu.</p>`;
    }
  }

  // Slutspelsväg (R32 opponents per finishing position)
  const pathEl = document.getElementById("se-path");
  if (pathEl) {
    const path = swedenR32Path();
    const line = (pos, info) =>
      info
        ? `<div class="insight"><span class="insight-ico">${pos.icon}</span><span class="insight-txt"><strong>Som ${pos.label}:</strong> möter ${slotLabel(info.opp)} i sextondelsfinalen${info.m?.DateUtc ? " · " + formatDate(info.m.DateUtc) : ""}${info.m?.Location ? " · " + info.m.Location : ""}.</span></div>`
        : "";
    const parts = [
      line({ icon: "🥇", label: "gruppvinnare" }, path.first),
      line({ icon: "🥈", label: "tvåa" }, path.second),
      line({ icon: "🥉", label: "bästa trea" }, path.third),
    ].filter(Boolean);
    pathEl.innerHTML = parts.length
      ? `<div class="insights">${parts.join("")}</div><p class="gr-actual">Motståndaren bestäms av slutplaceringen i Grupp F och lottningen av treorna.</p>`
      : `<p class="gr-actual">Slutspelsträdet sätts när gruppspelet är klart.</p>`;
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
    out.push({
      scorer,
      team: e.team?.displayName || "",
      penalty: isPen,
      clock: e.clock?.displayValue || "",
    });
  }
  return out;
}

// scorer key -> { name, team, goals:[{matchSv, opponentSv, clock, penalty}] }
const scorerGoals = new Map();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const cur = i++;
      out[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

let _highlightsToken = 0;
async function renderHighlights() {
  const container = document.getElementById("highlights");
  const myToken = ++_highlightsToken; // guard against overlapping renders
  const playedGames = state.picks.groupStage
    .map((m, idx) => ({ m, idx, f: findFixture(m.homeEn, m.awayEn) }))
    .filter(({ f }) => f?.HomeTeamScore != null && f?.AwayTeamScore != null)
    .sort((a, b) => new Date(b.f.DateUtc) - new Date(a.f.DateUtc));
  if (!playedGames.length) {
    container.innerHTML = `<p class="empty-state">Inga spelade matcher än. Skytteligan och klippen fylls på när matcherna spelats.</p>`;
    return;
  }

  container.innerHTML = `<div class="skel skel-card"></div><div class="skel skel-card"></div>`;

  // Fetch all summaries in parallel (limited concurrency) instead of serially.
  const fetched = await mapLimit(playedGames, 5, async (g) => {
    try {
      const eid = await getEventId(g.m.homeEn, g.m.awayEn, g.f.DateUtc);
      if (!eid) return null;
      const summary = await getSummary(eid);
      return { ...g, summary };
    } catch (e) {
      console.warn("highlight fetch failed", g.idx, e);
      return null;
    }
  });
  if (myToken !== _highlightsToken) return; // a newer render started

  const groups = [];
  const scorers = new Map(); // name -> { name, team, goals, pens }
  scorerGoals.clear();
  for (const item of fetched) {
    if (!item) continue;
    const { m, idx, f, summary } = item;
    for (const g of extractGoals(summary)) {
      const key = g.scorer + "|" + g.team;
      const rec = scorers.get(key) || { name: g.scorer, team: g.team, goals: 0, pens: 0 };
      rec.goals++;
      if (g.penalty) rec.pens++;
      scorers.set(key, rec);
      // remember where each goal was scored
      const teamIsHome = normTeam(toEspnName(m.homeEn)) === normTeam(g.team);
      const det = scorerGoals.get(key) || { name: g.scorer, team: g.team, goals: [] };
      det.goals.push({
        matchSv: `${m.homeSv} ${f.HomeTeamScore}–${f.AwayTeamScore} ${m.awaySv}`,
        opponentSv: teamIsHome ? m.awaySv : m.homeSv,
        clock: g.clock,
        penalty: g.penalty,
      });
      scorerGoals.set(key, det);
    }
    const videos = (summary.videos || []).filter((v) => v.links?.source?.href);
    if (videos.length) groups.push({ m, idx, f, videos });
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
      return `<li class="sk-row" data-scorer="${(s.name + "|" + s.team).replace(/"/g, "&quot;")}">
        <span class="sk-rank ${dr === 1 ? "lead" : ""}">${dr}</span>
        <span class="sk-flag">${teamLogoHtml(s.team, "sm")}</span>
        <span class="sk-name">${s.name}${pen}</span>
        <span class="sk-goals">${s.goals}</span>
        <span class="sk-chev">›</span>
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
              // Click-to-play: render a lightweight poster button; the <video>
              // is only created when the user taps (keeps the tab fast).
              return `<figure class="hl">
                <button class="hl-thumb" data-video="${src}" data-poster="${poster}" aria-label="Spela klipp">
                  ${poster ? `<img class="hl-poster" src="${poster}" alt="" loading="lazy" decoding="async">` : ""}
                  <span class="hl-play">▶</span>
                  ${dur ? `<span class="hl-badge">${dur}</span>` : ""}
                </button>
                <figcaption class="hl-cap"><span class="hl-title">${v.headline || ""}</span></figcaption>
              </figure>`;
            })
            .join("");
          return `<section class="hl-match">
            <div class="hl-match-head" data-open-match="${idx}">
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

function bestThirds() {
  const tables = computeGroupTables();
  const thirds = [];
  for (const [grp, rows] of Object.entries(tables)) {
    if (rows.length >= 3) thirds.push({ grp: grp.replace("Group ", ""), ...rows[2] });
  }
  thirds.sort(
    (a, b) =>
      b.pts - a.pts ||
      b.gf - b.ga - (a.gf - a.ga) ||
      b.gf - a.gf ||
      a.sv.localeCompare(b.sv, "sv"),
  );
  return thirds;
}

function renderBestThirds() {
  const thirds = bestThirds();
  if (!thirds.length) return "";
  const anyPlayed = thirds.some((t) => t.p > 0);
  const rows = thirds
    .map((t, i) => {
      const adv = i < 8;
      const gd = t.gf - t.ga;
      return `<li class="bt-row ${adv ? "bt-in" : "bt-out"}">
        <span class="bt-rank">${i + 1}</span>
        <span class="bt-flag">${teamLogoHtml(t.name, "sm")}</span>
        <span class="bt-name">${t.sv}<span class="bt-grp">grupp ${t.grp}</span></span>
        <span class="bt-stat">${t.pts}p</span>
        <span class="bt-stat bt-gd">${gd >= 0 ? "+" : ""}${gd}</span>
        <span class="bt-tag">${adv ? "✓" : ""}</span>
      </li>`;
    })
    .join("");
  return `<section class="bt-wrap">
    <div class="section-head"><h2>Bästa treor</h2><span class="section-sub">8 av 12 går vidare</span></div>
    <ol class="bt-list">${rows}</ol>
    <p class="bt-note">${anyPlayed ? "Preliminärt — uppdateras live efter varje match. ✓ = avancerar till slutspel." : "Rangordnas automatiskt från grupptabellerna när matcherna spelats."}</p>
  </section>`;
}

function koSlotShort(slot) {
  if (!slot) return "TBD";
  if (/to be announced/i.test(slot)) return "TBD";
  if (/^1[A-L]$/.test(slot)) return "1:a " + slot[1];
  if (/^2[A-L]$/.test(slot)) return "2:a " + slot[1];
  if (/^3/.test(slot)) return "3:a";
  if (/^W\d/.test(slot)) return "Vinnare";
  return slot;
}

function koBracketCard(m) {
  const home = isRealTeam(m.HomeTeam), away = isRealTeam(m.AwayTeam);
  const info = koInfo(m.HomeTeam, m.AwayTeam);
  const live = findLive(m.HomeTeam, m.AwayTeam);
  const isLive = live?.state === "in";
  let hs = m.HomeTeamScore, as = m.AwayTeamScore;
  if (info) { hs = info.hs; as = info.as; }
  if (isLive) { hs = Number(live.homeScore); as = Number(live.awayScore); }
  const loser = koLoserOf(m);
  const loserN = loser ? normTeam(toEspnName(loser)) : null;
  const decided = !!loserN;
  const teamRow = (t, score) => {
    const real = isRealTeam(t);
    const isLoser = real && loserN === normTeam(toEspnName(t));
    const isWin = real && decided && !isLoser;
    const nm = real ? svName(t) : koSlotShort(t);
    return `<div class="br-row ${isLoser ? "br-lose" : ""} ${isWin ? "br-win" : ""}">
      ${real ? teamLogoHtml(t, "sm") : '<span class="br-ph-dot"></span>'}
      <span class="br-name">${nm}</span>
      <span class="br-score">${score != null && (decided || isLive) ? score : ""}</span>
    </div>`;
  };
  const pens = info?.isPens && info.penH != null ? `<div class="br-pens">straffar ${info.penH}–${info.penA}</div>` : info?.isAet ? `<div class="br-pens">efter förläng.</div>` : "";
  const liveBadge = isLive ? `<div class="br-pens br-livetag"><span class="live-dot"></span>${live.clock || "live"}</div>` : "";
  return `<article class="br-card ${isLive ? "live" : ""}" ${home && away ? `data-ko="${m.MatchNumber}"` : ""}>
    ${teamRow(m.HomeTeam, hs)}
    ${teamRow(m.AwayTeam, as)}
    ${liveBadge || pens}
  </article>`;
}

function renderKnockout() {
  const list = state.fixtures?.matches || [];
  const rounds = [
    { r: 4, label: "16-delsfinal" },
    { r: 5, label: "8-delsfinal" },
    { r: 6, label: "Kvart" },
    { r: 7, label: "Semi" },
    { r: 8, label: "Final" },
  ];
  const cols = rounds
    .map(({ r, label }) => {
      const ms = list.filter((m) => m.RoundNumber === r).sort((a, b) => a.MatchNumber - b.MatchNumber);
      if (!ms.length) return "";
      const cards = ms.map(koBracketCard).join("");
      return `<div class="br-col"><div class="br-head">${label}</div><div class="br-matches">${cards}</div></div>`;
    })
    .join("");

  document.getElementById("knockout").innerHTML = `
    ${renderBestThirds()}
    <div class="section-head"><h2>Slutspelsträd</h2><span class="section-sub">dra i sidled →</span></div>
    <div class="bracket-scroll"><div class="bracket">${cols}</div></div>
  `;
}

function heroFlagBg(homeEn, awayEn) {
  const h = teamLogo(homeEn);
  const a = teamLogo(awayEn);
  if (!h && !a) return "";
  return `style="--hero-bg-h:url('${h || ""}'); --hero-bg-a:url('${a || ""}')"`;
}

function heroLinkAttr(fx) {
  if (fx.RoundNumber >= 4) return `data-ko="${fx.MatchNumber}"`;
  const idx = state.picks.groupStage.findIndex((m) => m.homeEn === fx.HomeTeam && m.awayEn === fx.AwayTeam);
  return idx >= 0 ? `data-open-match="${idx}"` : "";
}
function renderHero() {
  const el = document.getElementById("hero");
  if (!el) return;
  const now = Date.now();
  const cand = (state.fixtures?.matches || []).filter(
    (m) => m.DateUtc && isRealTeam(m.HomeTeam) && isRealTeam(m.AwayTeam),
  );
  const live = cand.find((m) => findLive(m.HomeTeam, m.AwayTeam)?.state === "in");
  const next = live
    ? null
    : cand.filter((m) => new Date(m.DateUtc).getTime() > now).sort((a, b) => new Date(a.DateUtc) - new Date(b.DateUtc))[0];
  const fx = live || next;
  if (!fx) { el.innerHTML = ""; return; }

  const homeSv = svName(fx.HomeTeam), awaySv = svName(fx.AwayTeam);
  const roundTag = fx.RoundNumber >= 4 ? koRoundLabel(fx.RoundNumber) : (fx.Group || "");
  let tag, centre;
  if (live) {
    const lv = findLive(fx.HomeTeam, fx.AwayTeam);
    tag = `<span class="live-dot"></span>Live nu · ${lv.clock || ""}${roundTag ? " · " + roundTag : ""}`;
    centre = `<div class="hero-big-score">${lv.homeScore}–${lv.awayScore}</div>`;
  } else {
    const msToGo = new Date(fx.DateUtc).getTime() - now;
    const hours = Math.floor(msToGo / 3_600_000), days = Math.floor(hours / 24);
    const cd = days > 0 ? `${days}d ${hours % 24}h` : hours > 0 ? `${hours}h ${Math.floor((msToGo % 3_600_000) / 60_000)}m` : `${Math.floor(msToGo / 60_000)} min`;
    tag = `${roundTag ? roundTag + " · " : "Nästa match · "}om ${cd}`;
    centre = `<div class="hero-vs-txt">vs</div><div class="hero-time">${formatDate(fx.DateUtc)}</div>`;
  }
  el.innerHTML = `<div class="hero-card ${live ? "live-card" : ""}" ${heroLinkAttr(fx)} ${heroFlagBg(fx.HomeTeam, fx.AwayTeam)}>
    <div class="hero-bg"></div>
    <div class="hero-content">
      <div class="hero-tag">${tag}</div>
      <div class="hero-teams">
        <div class="hero-side">${teamLogoHtml(fx.HomeTeam, "lg")}<div class="hero-team-name">${homeSv}</div></div>
        <div class="hero-vs-score">${centre}</div>
        <div class="hero-side">${teamLogoHtml(fx.AwayTeam, "lg")}<div class="hero-team-name">${awaySv}</div></div>
      </div>
      <div class="hero-sub">${fx.Location || ""}</div>
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
  // Auto-set the WC winner once the final is decided so the +2 bonus lands.
  const ks = knockoutState();
  if (ks.champion && !state.picks.actualWinner) {
    const champFx = (state.fixtures?.matches || []).find(
      (m) => isRealTeam(m.HomeTeam) && normTeam(toEspnName(m.HomeTeam)) === ks.champion,
    ) || (state.fixtures?.matches || []).find(
      (m) => isRealTeam(m.AwayTeam) && normTeam(toEspnName(m.AwayTeam)) === ks.champion,
    );
    const enName = champFx ? (normTeam(toEspnName(champFx.HomeTeam)) === ks.champion ? champFx.HomeTeam : champFx.AwayTeam) : null;
    if (enName) state.picks.actualWinner = enName;
  }
  const scores = computeScores();
  renderScoreboard(scores);
  renderTitleRace();
  renderHero();
  renderPulse();
  renderMatches();
  if (state.tab === "groups") renderGroups();
  if (state.tab === "sweden") renderSweden();
  if (state.tab === "knockout") renderKnockout();
  renderUpdated();
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".navbtn");
  if (tab) { switchTab(tab.dataset.tab); return; }

  const koChip = e.target.closest("[data-ko-round]");
  if (koChip) { state.koRound = Number(koChip.dataset.koRound); renderKnockout(); return; }

  const koCard = e.target.closest("[data-ko]");
  if (koCard) {
    const mn = Number(koCard.dataset.ko);
    const fx = state.fixtures.matches.find((x) => x.MatchNumber === mn);
    if (fx) openKoDetail(fx);
    return;
  }

  const skRow = e.target.closest(".sk-row[data-scorer]");
  if (skRow) { openScorer(skRow.dataset.scorer); return; }

  const thumb = e.target.closest(".hl-thumb");
  if (thumb) {
    const src = thumb.dataset.video;
    const poster = thumb.dataset.poster || "";
    const fig = thumb.closest(".hl");
    fig.querySelector(".hl-thumb").outerHTML = `<video class="hl-video" src="${src}" poster="${poster}" controls autoplay playsinline></video>`;
    return;
  }

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
  const key = pairKey(homeEn, awayEn);
  if (eventIdCache.has(key)) return eventIdCache.get(key);
  if (!dateUtc) return null;
  // ESPN buckets by US timezone — query the UTC date and its neighbours.
  const base = new Date(dateUtc.slice(0, 10) + "T12:00:00Z");
  const ymds = [-1, 0, 1].map((off) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + off);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  });
  try {
    for (const ymd of ymds) {
      const r = await fetch(`${ESPN_SCOREBOARD}?dates=${ymd}`, { cache: "no-store" });
      const j = await r.json();
      for (const e of j.events || []) {
        const c = e.competitions?.[0];
        const h = c?.competitors?.find((x) => x.homeAway === "home");
        const a = c?.competitors?.find((x) => x.homeAway === "away");
        if (!h || !a) continue;
        eventIdCache.set(normTeam(h.team.displayName) + "|" + normTeam(a.team.displayName), e.id);
      }
      if (eventIdCache.has(key)) return eventIdCache.get(key);
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

function detailConsensusHtml(m, outcome) {
  const counts = { "1": 0, X: 0, "2": 0 };
  let n = 0;
  for (const p of state.picks.players) {
    const pick = m.picks[p];
    if (pick) { counts[pick] = (counts[pick] || 0) + 1; n++; }
  }
  if (!n) return "";
  const top = ["1", "X", "2"].sort((a, b) => counts[b] - counts[a])[0];
  const label = top === "1" ? m.homeSv + " vinner" : top === "2" ? m.awaySv + " vinner" : "Oavgjort";
  let line = `Gruppens konsensus: <strong>${label}</strong> (${counts[top]}/${n}).`;
  if (outcome != null) {
    const right = counts[outcome] || 0;
    line += ` Resultatet gav <strong>${right}</strong> ${right === 1 ? "person" : "personer"} rätt.`;
    if (counts[outcome] === 0) line += " Ingen prickade rätt — skrällkväll. 😮";
    else if (counts[outcome] === n) line += " Alla rätt! 🎯";
  }
  return `<section class="detail-section"><h3>Tipsläget</h3><p class="ctx-line">${line}</p></section>`;
}

function detailContextHtml(m) {
  const f = findFixture(m.homeEn, m.awayEn);
  const grp = f?.Group;
  if (!grp) return "";
  const rows = computeGroupTables()[grp];
  if (!rows) return "";
  const rowOf = (en) => rows.find((r) => r.name === en) || rows.find((r) => normTeam(r.name) === normTeam(en));
  const hr = rowOf(m.homeEn);
  const ar = rowOf(m.awayEn);
  if (!hr || !ar) return "";
  const posOf = (r) => rows.indexOf(r) + 1;
  const cell = (sv, r) =>
    `<div class="ctx-team"><span class="ctx-pos">${posOf(r)}:a</span><span class="ctx-name">${sv}</span><span class="ctx-pts">${r.pts}p</span><span class="ctx-sub">${r.w}-${r.d}-${r.l} · ${r.gf}-${r.ga}</span></div>`;
  return `<section class="detail-section">
    <h3>Gruppläge · ${grp}</h3>
    <div class="ctx-grid">
      ${cell(m.homeSv, hr)}
      ${cell(m.awaySv, ar)}
    </div>
  </section>`;
}

function detailPreviewHtml(summary, m, oddsObj) {
  // A generated, data-driven preview that always has something to say.
  const p = impliedProbs(oddsObj);
  const bits = [];
  if (p) {
    const arr = [
      { k: m.homeSv, v: p.home },
      { k: "oavgjort", v: p.draw },
      { k: m.awaySv, v: p.away },
    ].sort((a, b) => b.v - a.v);
    const fav = arr[0];
    const pc = Math.round(fav.v * 100);
    if (fav.k === "oavgjort") bits.push(`Marknaden ser en jämn match — mest troliga utfall är oavgjort (${pc}%).`);
    else bits.push(`Marknaden gör <strong>${fav.k}</strong> till favorit med ${pc}% sannolikhet.`);
  }
  const sets = summary?.lastFiveGames;
  if (Array.isArray(sets)) {
    for (const s of sets) {
      const ev = (s.events || []).slice(-5);
      const w = ev.filter((e) => e.gameResult === "W").length;
      const l = ev.filter((e) => e.gameResult === "L").length;
      const name = s.team?.displayName || "";
      const sv = name === toEspnName(m.homeEn) ? m.homeSv : name === toEspnName(m.awayEn) ? m.awaySv : name;
      if (ev.length) {
        const trend = w >= 4 ? "glödhet form" : w >= 3 ? "fin form" : l >= 3 ? "svajig form" : "blandad form";
        bits.push(`${sv}: ${w}V-${ev.length - w - l}O-${l}F senaste ${ev.length} (${trend}).`);
      }
    }
  }
  const h2h = summary?.headToHeadGames?.events;
  if (h2h?.length) bits.push(`Lagen har mötts ${h2h.length} ggr tidigare (se H2H nedan).`);
  if (!bits.length) return "";
  return `<section class="detail-section"><h3>Förhandsanalys</h3><p class="ctx-line">${bits.join(" ")}</p></section>`;
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
  // Sections built purely from our own data — always present, instantly.
  const baseSections = `
    ${detailOurPicksHtml(m, outcome)}
    ${detailConsensusHtml(m, outcome)}
    ${detailContextHtml(m)}
  `;
  body.innerHTML = `
    ${sheetHeader("detail")}
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
    ${baseSections}
    <div id="detail-extra"><div class="skel skel-line"></div><div class="skel skel-line"></div></div>
  `;
  document.documentElement.classList.add("modal-open");
  dlg.showModal();

  const extra = () => document.getElementById("detail-extra");
  try {
    const eid = await getEventId(m.homeEn, m.awayEn, f?.DateUtc);
    if (!eid) {
      extra().innerHTML = `${detailVenueHtml({ gameInfo: { venue: f?.Location ? { fullName: f.Location } : null } })}
        <p class="detail-empty">Live-statistik och höjdpunkter dyker upp närmare matchstart.</p>`;
      return;
    }
    const summary = await getSummary(eid);
    const oddsObj = summary.pickcenter?.[0] || summary.odds?.[0];
    const played = outcome != null;
    const sections = [
      detailOddsHtml(oddsObj),
      detailProbabilityHtml(oddsObj, m),
      played ? "" : detailPreviewHtml(summary, m, oddsObj),
      detailFormHtml(summary),
      detailHighlightsHtml(summary),
      collapsible("Analys", detailArticleHtml(summary)),
      collapsible("Head-to-head", detailH2HHtml(summary)),
      collapsible("Händelser", detailEventsHtml(summary)),
      collapsible("Nyheter", detailNewsHtml(summary, m)),
      detailVenueHtml(summary) || detailVenueHtml({ gameInfo: { venue: f?.Location ? { fullName: f.Location } : null } }),
    ].filter(Boolean);
    extra().innerHTML = sections.join("\n");
  } catch (err) {
    extra().innerHTML = `${detailVenueHtml({ gameInfo: { venue: f?.Location ? { fullName: f.Location } : null } })}
      <p class="detail-empty">Kunde inte hämta extra statistik just nu.</p>`;
  }
}

let _svByEn = null;
function svName(en) {
  if (!en) return en;
  if (!_svByEn) {
    _svByEn = {};
    for (const [sv, e] of Object.entries(state.picks?.mapping || {})) _svByEn[normTeam(e)] = sv;
  }
  return _svByEn[normTeam(en)] || _svByEn[normTeam(toEspnName(en))] || en;
}
function koRoundLabel(r) {
  return { 4: "Sextondelsfinal", 5: "Åttondelsfinal", 6: "Kvartsfinal", 7: "Semifinal", 8: "Final / Bronsmatch" }[r] || "";
}
// Result line for a knockout match (handles live, extra time, penalties, upcoming)
function koScoreLine(fx) {
  const live = findLive(fx.HomeTeam, fx.AwayTeam);
  if (live?.state === "in")
    return `<span class="detail-score live">${live.homeScore}–${live.awayScore}</span><span class="live-badge"><span class="live-dot"></span>${live.clock || ""}</span>`;
  const info = koInfo(fx.HomeTeam, fx.AwayTeam);
  let hs = fx.HomeTeamScore, as = fx.AwayTeamScore;
  if (info) { hs = info.hs; as = info.as; }
  if (hs != null && as != null) {
    let extra = "";
    if (info?.isPens && info.penH != null) extra = ` <span class="ko-extra">straffar ${info.penH}–${info.penA}</span>`;
    else if (info?.isAet) extra = ` <span class="ko-extra">e.f.</span>`;
    return `<span class="detail-score">${hs}–${as}</span>${extra}`;
  }
  return fx.DateUtc ? `<span class="detail-when">${formatDate(fx.DateUtc)}</span>` : "";
}

async function openKoDetail(fx) {
  if (!fx || !isRealTeam(fx.HomeTeam) || !isRealTeam(fx.AwayTeam)) return;
  const dlg = document.getElementById("detail");
  const body = document.getElementById("detail-body");
  const homeSv = svName(fx.HomeTeam), awaySv = svName(fx.AwayTeam);
  const m = { homeEn: fx.HomeTeam, awayEn: fx.AwayTeam, homeSv, awaySv, picks: {} };
  body.innerHTML = `
    ${sheetHeader("detail")}
    <header class="detail-header">
      <div class="detail-round-tag">${koRoundLabel(fx.RoundNumber)}</div>
      <div class="detail-hero">
        <div class="detail-team-cell">${teamLogoHtml(fx.HomeTeam, "lg")}<span class="detail-team-name">${homeSv}</span></div>
        <div class="detail-vs">${koScoreLine(fx) || '<span class="detail-vs-txt">vs</span>'}</div>
        <div class="detail-team-cell">${teamLogoHtml(fx.AwayTeam, "lg")}<span class="detail-team-name">${awaySv}</span></div>
      </div>
    </header>
    <div id="detail-extra"><div class="skel skel-line"></div><div class="skel skel-line"></div></div>`;
  document.documentElement.classList.add("modal-open");
  dlg.showModal();
  const extra = () => document.getElementById("detail-extra");
  try {
    const eid = await getEventId(fx.HomeTeam, fx.AwayTeam, fx.DateUtc);
    if (!eid) {
      extra().innerHTML = `${detailVenueHtml({ gameInfo: { venue: fx.Location ? { fullName: fx.Location } : null } })}<p class="detail-empty">Statistik och höjdpunkter dyker upp närmare matchstart.</p>`;
      return;
    }
    const summary = await getSummary(eid);
    const oddsObj = summary.pickcenter?.[0] || summary.odds?.[0];
    const played = fx.HomeTeamScore != null || !!koInfo(fx.HomeTeam, fx.AwayTeam);
    extra().innerHTML = [
      detailOddsHtml(oddsObj),
      detailProbabilityHtml(oddsObj, m),
      played ? "" : detailPreviewHtml(summary, m, oddsObj),
      detailFormHtml(summary),
      detailHighlightsHtml(summary),
      collapsible("Analys", detailArticleHtml(summary)),
      collapsible("Head-to-head", detailH2HHtml(summary)),
      collapsible("Händelser", detailEventsHtml(summary)),
      collapsible("Nyheter", detailNewsHtml(summary, m)),
      detailVenueHtml(summary) || detailVenueHtml({ gameInfo: { venue: fx.Location ? { fullName: fx.Location } : null } }),
    ].filter(Boolean).join("\n");
  } catch (err) {
    extra().innerHTML = `<p class="detail-empty">Kunde inte hämta statistik just nu.</p>`;
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
  const hadController = !!navigator.serviceWorker.controller;
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloadedForUpdate) return; // skip reload on first install
    reloadedForUpdate = true;
    location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      // Check for a newer service worker now and whenever the tab refocuses.
      reg.update();
      setInterval(() => reg.update(), 5 * 60_000);
      window.addEventListener("focus", () => reg.update());
    } catch (e) {
      /* ignore */
    }
  });
}

load()
  .then(() => pollLive())
  .catch((err) => {
    console.error(err);
    $("#scoreboard").innerHTML = `<li><span>Kunde inte ladda data: ${err.message}</span></li>`;
  });
