# Candidates 2026 Tracker

Seed data and a small React app for the Lichess broadcast of the 2026 FIDE Candidates Open.

Current snapshot date: 2026-03-29

Files:

- `data/open_pairings.json`: players and round-by-round pairings from the Lichess broadcast
- `scripts/fetch_open_pairings.py`: refreshes the snapshot from Lichess
- `index.html` and `src/`: zero-build React app for browsing results by round

Run locally:

- `python3 -m http.server 4173`
- Open `http://localhost:4173`

Sources:

- https://lichess.org/api#tag/Broadcasts
- https://lichess.org/broadcast/fide-candidates-2026-open/BLA70Vds
