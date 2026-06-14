const PICKS_URL = "data/picks.json";
const FIXTURES_URL = "data/fixtures.json";

const $ = (sel) => document.querySelector(sel);

const state = {
  picks: null,
  fixtures: null,
  filter: "all",
};

async function load() {
  const bust = `?v=${Date.now()}`;
  const [picks, fixtures] = await Promise.all([
    fetch(PICKS_URL + bust).then((r) => r.json()),
    fetch(FIXTURES_URL + bust).then((r) => r.json()),
  ]);
  state.picks = picks;
  state.fixtures = fixtures;
  render();
}

function findFixture(homeEn, awayEn) {
  return state.fixtures.matches.find(
    (m) => m.HomeTeam === homeEn && m.AwayTeam === awayEn,
  );
}

function outcomeFromScores(h, a) {
  if (h == null || a == null) return null;
  if (h > a) return "1";
  if (h < a) return "2";
  return "X";
}

function computeScores() {
  const { picks, fixtures } = state;
  const scores = Object.fromEntries(picks.players.map((p) => [p, { pts: 0, bonus: 0 }]));

  for (const m of picks.groupStage) {
    const f = findFixture(m.homeEn, m.awayEn);
    if (!f) continue;
    const outcome = outcomeFromScores(f.HomeTeamScore, f.AwayTeamScore);
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
    const f = findFixture(m.homeEn, m.awayEn);
    const homeScore = f?.HomeTeamScore ?? null;
    const awayScore = f?.AwayTeamScore ?? null;
    const outcome = outcomeFromScores(homeScore, awayScore);
    const played = outcome != null;
    return { m, f, homeScore, awayScore, outcome, played };
  });

  const filtered = rows.filter((r) => {
    if (state.filter === "played") return r.played;
    if (state.filter === "upcoming") return !r.played;
    return true;
  });

  filtered.sort((a, b) => {
    const da = a.f?.DateUtc ? new Date(a.f.DateUtc).getTime() : 0;
    const db = b.f?.DateUtc ? new Date(b.f.DateUtc).getTime() : 0;
    return da - db;
  });

  const html = filtered
    .map(({ m, f, homeScore, awayScore, outcome, played }) => {
      const score = played
        ? `<span class="match-result">${homeScore}–${awayScore}</span>`
        : `<span class="match-result pending">vs</span>`;
      const dateStr = f?.DateUtc ? formatDate(f.DateUtc) : "";
      const outcomeBadge = played ? `<span class="outcome-badge">${outcome}</span>` : "";
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
      return `<article class="match">
        <div class="match-head">
          <div class="match-teams">
            ${m.homeSv} – ${m.awaySv} ${score} ${outcomeBadge}
          </div>
          <div class="match-date">${dateStr}</div>
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

load().catch((err) => {
  console.error(err);
  $("#scoreboard").innerHTML = `<li><span>Kunde inte ladda data: ${err.message}</span></li>`;
});
