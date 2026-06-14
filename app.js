const PICKS_URL = "data/picks.json";
const FIXTURES_URL = "data/fixtures.json";
const LIVE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

const $ = (sel) => document.querySelector(sel);

const state = {
  picks: null,
  fixtures: null,
  live: {},
  liveFetchedAt: null,
  filter: "all",
};

async function load() {
  const bust = `?v=${Date.now()}`;
  const opts = { cache: "no-store" };
  const [picks, fixtures] = await Promise.all([
    fetch(PICKS_URL + bust, opts).then((r) => r.json()),
    fetch(FIXTURES_URL + bust, opts).then((r) => r.json()),
  ]);
  state.picks = picks;
  state.fixtures = fixtures;
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
      return `<li class="${isLeader ? "leader" : ""}">
        <span class="rank">${displayRank}</span>
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
  const rows = picks.groupStage.map((m) => {
    const { home, away, fixture: f } = resolvedScores(m);
    const live = findLive(m.homeEn, m.awayEn);
    const isLive = live?.state === "in";
    const liveHome = isLive ? Number(live.homeScore) : null;
    const liveAway = isLive ? Number(live.awayScore) : null;
    const outcome = outcomeFromScores(home, away);
    const played = outcome != null;
    return { m, f, live, isLive, liveHome, liveAway, homeScore: home, awayScore: away, outcome, played };
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
    .map(({ m, f, live, isLive, liveHome, liveAway, homeScore, awayScore, outcome, played }) => {
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
      return `<article class="${articleClass}">
        <div class="match-head">
          <div class="match-teams">
            ${m.homeSv} – ${m.awaySv} ${score} ${outcomeBadge}
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

function render() {
  const scores = computeScores();
  renderScoreboard(scores);
  renderMatches();
  renderUpdated();
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter");
  if (!btn) return;
  document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.filter = btn.dataset.filter;
  renderMatches();
});

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
