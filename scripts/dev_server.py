#!/usr/bin/env python3

import json
import re
import subprocess
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
PORT = 4173
LIVE_CACHE_MS = 60 * 1000
ROUND_CACHE = {}


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "candidates-2026-tracker"})
    try:
        with urlopen(request) as response:
            return response.read().decode("utf-8")
    except Exception:
        return subprocess.check_output(
            ["curl", "-fsSL", "-A", "candidates-2026-tracker", url],
            text=True,
        )


def parse_page_data(html: str) -> dict:
    match = re.search(
        r'<script type="application/json" id="page-init-data">([\s\S]*?)</script>',
        html,
    )
    if not match:
        raise ValueError("Could not find page-init-data JSON")
    return json.loads(match.group(1))


def extract_chapter_move_info(data: dict) -> dict:
    tree_parts = data.get("data", {}).get("treeParts", [])
    last_part = tree_parts[-1] if tree_parts else {}
    return {
        "lastMoveSan": last_part.get("san") if isinstance(last_part.get("san"), str) else None,
        "ply": last_part.get("ply") if isinstance(last_part.get("ply"), int) else None,
    }


def normalize_result(result: str | None) -> str:
    if result == "½-½":
        return "1/2-1/2"
    return result or "*"


def build_live_games(round_url: str, data: dict) -> list[dict]:
    chapters = data.get("study", {}).get("chapters", [])
    games = []

    for index, chapter in enumerate(chapters):
        broadcast_url = (
            f"{round_url}/{chapter.get('id')}" if chapter.get("id") else round_url
        )
        move_info = {"lastMoveSan": None, "ply": None}

        if chapter.get("id"):
            try:
                chapter_html = fetch_text(broadcast_url)
                move_info = extract_chapter_move_info(parse_page_data(chapter_html))
            except Exception:
                pass

        games.append(
            {
                "board": index + 1,
                "chapterId": chapter.get("id"),
                "white": (chapter.get("players") or [{}])[0].get("name"),
                "black": (chapter.get("players") or [{}, {}])[1].get("name"),
                "fen": chapter.get("fen"),
                "lastMove": chapter.get("lastMove"),
                "lastMoveSan": move_info["lastMoveSan"],
                "ply": move_info["ply"],
                "result": normalize_result(chapter.get("status")),
                "broadcastUrl": broadcast_url,
            }
        )

    return games

class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/live-round":
            return self.handle_live_round(parsed)

        return super().do_GET()

    def respond_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "s-maxage=60, stale-while-revalidate=120")
        self.end_headers()
        self.wfile.write(body)

    def handle_live_round(self, parsed):
        query = parse_qs(parsed.query)
        round_url = query.get("roundUrl", [None])[0]

        if not round_url:
            return self.respond_json({"error": "Missing roundUrl"}, 400)

        try:
            parsed_round_url = urlparse(round_url)
        except ValueError:
            return self.respond_json({"error": "Invalid roundUrl"}, 400)

        if (
            parsed_round_url.scheme != "https"
            or parsed_round_url.netloc != "lichess.org"
            or not parsed_round_url.path.startswith("/broadcast/")
        ):
            return self.respond_json(
                {"error": "roundUrl must be a lichess broadcast URL"}, 400
            )

        cached = ROUND_CACHE.get(round_url)
        if cached and time.time() * 1000 - cached["timestamp"] < LIVE_CACHE_MS:
            return self.respond_json(cached["payload"])

        try:
            html = fetch_text(round_url)
            data = parse_page_data(html)
            payload = {
                "roundUrl": round_url,
                "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "games": build_live_games(round_url, data),
            }
            ROUND_CACHE[round_url] = {
                "timestamp": time.time() * 1000,
                "payload": payload,
            }
            return self.respond_json(payload)
        except Exception as error:
            return self.respond_json({"error": str(error)}, 500)

def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(DevHandler))
    print(f"Serving Candidates tracker with API routes on http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
