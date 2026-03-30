#!/usr/bin/env python3

import json
import re
import subprocess
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTFILE = ROOT / "data" / "open_pairings.json"
START_URL = "https://lichess.org/broadcast/fide-candidates-2026-open/round-1/uLCZwqAK"


def fetch(url: str) -> str:
    return subprocess.check_output(["curl", "-fsSL", url], text=True)


def page_data(html: str) -> dict:
    match = re.search(
        r'<script type="application/json" id="page-init-data">(.*?)</script>',
        html,
        re.DOTALL,
    )
    if not match:
        raise RuntimeError("Could not find Lichess page-init-data JSON")
    return json.loads(match.group(1))


def normalize_result(result: str | None) -> str | None:
    if result == "½-½":
        return "1/2-1/2"
    return result


def main() -> None:
    initial = page_data(fetch(START_URL))
    relay = initial["relay"]

    players = []
    seen = set()
    for chapter in initial["study"].get("chapters", []):
        for player in chapter.get("players", []):
            name = player["name"]
            if name not in seen:
                seen.add(name)
                players.append(
                    {
                        "name": name,
                        "rating": player.get("rating"),
                    }
                )

    rounds = []
    for rnd in relay["rounds"]:
        data = page_data(fetch(rnd["url"]))
        pairings = []
        for board, chapter in enumerate(data["study"].get("chapters", []), start=1):
            white, black = chapter["players"]
            pairings.append(
                {
                    "board": board,
                    "white": white["name"],
                    "black": black["name"],
                    "result": normalize_result(chapter.get("status")),
                }
            )

        rounds.append(
            {
                "name": rnd["name"],
                "url": rnd["url"],
                "pairings": pairings,
            }
        )

    payload = {
        "event": relay["tour"]["name"],
        "snapshot_date": str(date.today()),
        "source": relay["tour"]["url"],
        "website": relay["tour"]["info"]["website"],
        "players": players,
        "rounds": rounds,
    }

    OUTFILE.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
