# VM Tipset 2026

Live scoreboard for our FIFA World Cup 2026 pool. Pure static site (HTML + JS),
installs to iPhone home screen as a PWA, fixtures refresh themselves via a
GitHub Action.

## How it works

- `data/picks.json` — every friend's pick for every group-stage match plus the
  bonus "Vem vinner?" pick. Baked in once at the start of the tournament.
- `data/fixtures.json` — mirror of fixturedownload.com's JSON feed, refreshed
  every 30 minutes by `.github/workflows/refresh.yml`.
- `app.js` — fetches both, computes scores live (1p per correct 1/X/2; +2p
  bonus if `actualWinner` matches your winner pick), renders scoreboard +
  matches.

## Deploy to GitHub Pages

1. Create a new GitHub repo named e.g. `vm-tipset-2026` (public is simplest;
   private also works).
2. From this folder:
   ```
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<your-username>/vm-tipset-2026.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from
   a branch → Branch: `main` / root → Save**.
4. Wait ~1 minute. The site goes live at
   `https://<your-username>.github.io/vm-tipset-2026/`.
5. Confirm the workflow runs: **Actions tab → "Refresh fixtures" → Run workflow**
   once manually to seed; from then on it runs every 30 minutes.

## Add to iPhone home screen

1. Open the site in **Safari** on iPhone (Chrome won't install PWAs the same way).
2. Tap **Share → Add to Home Screen → Add**.
3. The "VM Tipset" icon appears on your home screen. Opens full-screen, no
   browser chrome, looks like a real app.

## Updating the actual winner (the +2p bonus)

When you know the WC winner, edit `data/picks.json`:
```json
"actualWinner": "Argentina"
```
Use the Swedish team name (same form as in `winnerPicks`). Commit + push.
Within seconds everyone's installed PWA pulls the update next time they open it.

## Sharing

Send friends the same URL. They each tap **Add to Home Screen** and they all
see the same live scoreboard. To let a friend edit their own picks later: see
"Future" below.

## Future (when you want it)

- **Let friends edit their own picks**: swap `data/picks.json` for a Google
  Sheet and have `app.js` fetch it as CSV. Lower friction than asking everyone
  to PR a JSON file.
- **Push notifications when a match finishes**: a second GitHub Action that
  diffs `fixtures.json` and posts to a webhook (Discord/Telegram). Not built —
  ask when you want it.

## Local development

```
node _serve.js
# open http://localhost:8765
```

The `_serve.js` and `_reseed.js` files are dev-only helpers. They are
harmless on Pages (Pages just serves them as static files) but you can delete
them before pushing if you prefer a clean repo.
