# Candidates 2026 Tracker

Seed data and a small React app for the Lichess broadcast of the 2026 FIDE Candidates Open.

License: GPL-3.0. The live analysis feature uses a bundled Stockfish browser build in `vendor/stockfish`.

Current snapshot date: 2026-03-29

Files:

- `data/open_pairings.json`: players and round-by-round pairings from the Lichess broadcast
- `data/women_pairings.json`: players and round-by-round pairings for the women's event
- `scripts/fetch_pairings.py`: refreshes both snapshots from Lichess
- `index.html` and `src/`: zero-build React app for browsing results by round

Run locally:

- `python3 scripts/dev_server.py`
- Open `http://localhost:4173`

Live in-progress boards use the local `/api/live-round` endpoint plus a bundled browser Stockfish build for W/D/B analysis.

Update data manually:

- `python3 scripts/fetch_pairings.py`

Automatic updates:

- `.github/workflows/daily-refresh.yml` refreshes both JSON files once per day and pushes changes back to `main`

Sources:

- https://lichess.org/api#tag/Broadcasts
- https://lichess.org/broadcast/fide-candidates-2026-open/BLA70Vds
