#!/usr/bin/env python3

import hashlib
import json
import os
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SIMULATION_COUNT = int(os.environ.get("SIMULATION_COUNT", "1000000"))
CHUNK_SIZE = int(os.environ.get("SIMULATION_CHUNK_SIZE", "100000"))
WHITE_ADVANTAGE_ELO = 35
DRAW_RATE_AT_EQUAL = 0.62
DRAW_DECAY_ELO = 700
FORM_PRIOR_GAMES = 6
FORM_MAX_ELO_SHIFT = 120
FORECAST_CACHE_VERSION = "server-v2"
PAIRING_FILES = {
    "open": DATA_DIR / "open_pairings.json",
    "women": DATA_DIR / "women_pairings.json",
}
FORECAST_FILES = {
    "open": DATA_DIR / "open_forecasts.json",
    "women": DATA_DIR / "women_forecasts.json",
}


def score_for_result(result: str) -> tuple[float, float]:
    if result == "1-0":
        return 1.0, 0.0
    if result == "0-1":
        return 0.0, 1.0
    if result == "1/2-1/2":
        return 0.5, 0.5
    return 0.0, 0.0


def is_round_completed(round_data: dict) -> bool:
    return all(game.get("result") and game["result"] != "*" for game in round_data["pairings"])


def probability_model(white_rating, black_rating):
    adjusted_delta = white_rating + WHITE_ADVANTAGE_ELO - black_rating
    expected_white = 1 / (1 + np.power(10.0, -adjusted_delta / 400.0))
    draw_cap = 2 * np.minimum(expected_white, 1 - expected_white)
    draw_probability = np.minimum(
        DRAW_RATE_AT_EQUAL * np.exp(-np.abs(adjusted_delta) / DRAW_DECAY_ELO),
        draw_cap,
    )
    white_win_probability = expected_white - draw_probability / 2
    black_win_probability = 1 - white_win_probability - draw_probability
    return expected_white, white_win_probability, draw_probability, black_win_probability


def expected_score(player_rating: float, opponent_rating: float, is_white: bool, form_delta: float = 0.0) -> float:
    if is_white:
        return float(probability_model(player_rating + form_delta, opponent_rating)[0])
    return float(1 - probability_model(opponent_rating, player_rating + form_delta)[0])


def infer_posterior_form(data: dict, completed_round_count: int, player_lookup: dict[str, dict]) -> dict[str, float]:
    player_games = {
        player["name"]: {
            "player": player,
            "games": [],
            "actual_score": 0.0,
        }
        for player in data["players"]
    }

    for round_data in data["rounds"][:completed_round_count]:
        for game in round_data["pairings"]:
            result = game.get("result")
            if not result or result == "*":
                continue

            white_score, black_score = score_for_result(result)
            white_player = player_lookup[game["white"]]
            black_player = player_lookup[game["black"]]

            player_games[game["white"]]["games"].append(
                {
                    "opponent": black_player,
                    "is_white": True,
                    "actual_score": white_score,
                }
            )
            player_games[game["white"]]["actual_score"] += white_score

            player_games[game["black"]]["games"].append(
                {
                    "opponent": white_player,
                    "is_white": False,
                    "actual_score": black_score,
                }
            )
            player_games[game["black"]]["actual_score"] += black_score

    form_map = {}
    for name, payload in player_games.items():
        games = payload["games"]
        if not games:
            form_map[name] = 0.0
            continue

        low = -FORM_MAX_ELO_SHIFT
        high = FORM_MAX_ELO_SHIFT

        for _ in range(24):
            mid = (low + high) / 2
            expected_total = sum(
                expected_score(
                    payload["player"]["rating"],
                    game["opponent"]["rating"],
                    game["is_white"],
                    mid,
                )
                for game in games
            )

            if expected_total < payload["actual_score"]:
                low = mid
            else:
                high = mid

        raw_shift = (low + high) / 2
        shrink = len(games) / (len(games) + FORM_PRIOR_GAMES)
        form_map[name] = raw_shift * shrink

    return form_map


def simulate_scores_batch(
    base_scores,
    remaining_games,
    batch_size: int,
    rng: np.random.Generator,
    tracked_game_count: int = 0,
):
    scores = np.tile(base_scores, (batch_size, 1)).astype(np.float64)
    tracked_counts = (
        np.zeros((tracked_game_count, 3), dtype=np.float64)
        if tracked_game_count > 0
        else None
    )

    for game_index, (white_index, black_index, white_rating, black_rating) in enumerate(remaining_games):
        _, white_win_probability, draw_probability, _ = probability_model(
            white_rating,
            black_rating,
        )
        draws = rng.random(batch_size)
        white_wins = draws < white_win_probability
        draws_mask = (draws >= white_win_probability) & (
            draws < white_win_probability + draw_probability
        )
        black_wins = ~(white_wins | draws_mask)

        scores[:, white_index] += white_wins.astype(np.float64) + 0.5 * draws_mask.astype(np.float64)
        scores[:, black_index] += black_wins.astype(np.float64) + 0.5 * draws_mask.astype(np.float64)

        if tracked_counts is not None and game_index < tracked_game_count:
            tracked_counts[game_index, 0] += white_wins.sum()
            tracked_counts[game_index, 1] += draws_mask.sum()
            tracked_counts[game_index, 2] += black_wins.sum()

    return scores, tracked_counts


def sudden_death_win_probability(player_a: int, player_b: int, ratings: np.ndarray) -> float:
    _, a_white_win_probability, a_draw_probability, _ = probability_model(
        ratings[player_a],
        ratings[player_b],
    )
    _, _, b_draw_probability, b_black_win_probability = probability_model(
        ratings[player_b],
        ratings[player_a],
    )
    a_one_game = 0.5 * a_white_win_probability + 0.5 * b_black_win_probability
    draw_one_game = 0.5 * a_draw_probability + 0.5 * b_draw_probability
    decisive_share = max(1 - draw_one_game, 1e-9)
    return a_one_game / decisive_share


def simulate_one_game(player_a: int, player_b: int, ratings: np.ndarray, rng: np.random.Generator, white_player: int | None = None):
    if white_player is None:
        white_player = player_a if rng.random() < 0.5 else player_b
    black_player = player_b if white_player == player_a else player_a
    _, white_win_probability, draw_probability, _ = probability_model(
        ratings[white_player],
        ratings[black_player],
    )
    draw = rng.random()
    if draw < white_win_probability:
        return (1.0, 0.0) if white_player == player_a else (0.0, 1.0)
    if draw < white_win_probability + draw_probability:
        return 0.5, 0.5
    return (0.0, 1.0) if white_player == player_a else (1.0, 0.0)


def simulate_two_game_match(player_a: int, player_b: int, ratings: np.ndarray, rng: np.random.Generator) -> tuple[float, float]:
    first_white = player_a if rng.random() < 0.5 else player_b
    first = simulate_one_game(player_a, player_b, ratings, rng, first_white)
    second = simulate_one_game(player_a, player_b, ratings, rng, player_b if first_white == player_a else player_a)
    return first[0] + second[0], first[1] + second[1]


def resolve_round_robin(players: np.ndarray, ratings: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    scores = np.zeros(len(players), dtype=np.float64)

    for left_index in range(len(players)):
        for right_index in range(left_index + 1, len(players)):
            left_score, right_score = simulate_one_game(
                int(players[left_index]),
                int(players[right_index]),
                ratings,
                rng,
            )
            scores[left_index] += left_score
            scores[right_index] += right_score

    return players[scores == scores.max()]


def resolve_knockout(players: np.ndarray, ratings: np.ndarray, rng: np.random.Generator) -> int:
    field = np.array(players, dtype=np.int64)
    rng.shuffle(field)

    while len(field) > 1:
        next_round = []
        if len(field) % 2 == 1:
            next_round.append(int(field[-1]))
            field = field[:-1]

        for index in range(0, len(field), 2):
            player_a = int(field[index])
            player_b = int(field[index + 1])
            win_probability = sudden_death_win_probability(player_a, player_b, ratings)
            next_round.append(player_a if rng.random() < win_probability else player_b)

        field = np.array(next_round, dtype=np.int64)
        rng.shuffle(field)

    return int(field[0])


def resolve_first_place_winners(order: np.ndarray, sorted_scores: np.ndarray, rapid_ratings: np.ndarray, blitz_ratings: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    winners = order[:, 0].copy()
    top_tie_sizes = np.sum(sorted_scores == sorted_scores[:, [0]], axis=1)

    two_way_mask = top_tie_sizes == 2
    if np.any(two_way_mask):
        row_indexes = np.where(two_way_mask)[0]
        player_a = order[row_indexes, 0]
        player_b = order[row_indexes, 1]
        first_white_is_a = rng.random(len(row_indexes)) < 0.5
        rapid_scores_a = np.zeros(len(row_indexes), dtype=np.float64)
        rapid_scores_b = np.zeros(len(row_indexes), dtype=np.float64)

        for game_index in range(2):
            white_is_a = first_white_is_a if game_index == 0 else ~first_white_is_a
            white_player = np.where(white_is_a, player_a, player_b)
            black_player = np.where(white_is_a, player_b, player_a)
            _, white_win_probability, draw_probability, _ = probability_model(
                rapid_ratings[white_player],
                rapid_ratings[black_player],
            )
            draws = rng.random(len(row_indexes))
            white_wins = draws < white_win_probability
            draws_mask = (draws >= white_win_probability) & (
                draws < white_win_probability + draw_probability
            )

            score_a = np.where(white_is_a, white_wins.astype(np.float64), 1 - white_wins.astype(np.float64) - draws_mask.astype(np.float64))
            score_a = np.where(draws_mask, 0.5, score_a)
            score_b = 1 - score_a
            rapid_scores_a += score_a
            rapid_scores_b += score_b

        winners[row_indexes] = np.where(
            rapid_scores_a > rapid_scores_b,
            player_a,
            np.where(rapid_scores_b > rapid_scores_a, player_b, winners[row_indexes]),
        )

        tied_after_rapid = row_indexes[rapid_scores_a == rapid_scores_b]
        if len(tied_after_rapid):
            blitz_a = order[tied_after_rapid, 0]
            blitz_b = order[tied_after_rapid, 1]
            first_white_is_a = rng.random(len(tied_after_rapid)) < 0.5
            blitz_scores_a = np.zeros(len(tied_after_rapid), dtype=np.float64)
            blitz_scores_b = np.zeros(len(tied_after_rapid), dtype=np.float64)

            for game_index in range(2):
                white_is_a = first_white_is_a if game_index == 0 else ~first_white_is_a
                white_player = np.where(white_is_a, blitz_a, blitz_b)
                black_player = np.where(white_is_a, blitz_b, blitz_a)
                _, white_win_probability, draw_probability, _ = probability_model(
                    blitz_ratings[white_player],
                    blitz_ratings[black_player],
                )
                draws = rng.random(len(tied_after_rapid))
                white_wins = draws < white_win_probability
                draws_mask = (draws >= white_win_probability) & (
                    draws < white_win_probability + draw_probability
                )
                score_a = np.where(white_is_a, white_wins.astype(np.float64), 1 - white_wins.astype(np.float64) - draws_mask.astype(np.float64))
                score_a = np.where(draws_mask, 0.5, score_a)
                score_b = 1 - score_a
                blitz_scores_a += score_a
                blitz_scores_b += score_b

            winners[tied_after_rapid] = np.where(
                blitz_scores_a > blitz_scores_b,
                blitz_a,
                np.where(blitz_scores_b > blitz_scores_a, blitz_b, winners[tied_after_rapid]),
            )

            still_tied = tied_after_rapid[blitz_scores_a == blitz_scores_b]
            for row_index in still_tied:
                player_a = int(order[row_index, 0])
                player_b = int(order[row_index, 1])
                win_probability = sudden_death_win_probability(player_a, player_b, blitz_ratings)
                winners[row_index] = player_a if rng.random() < win_probability else player_b

    for row_index in np.where(top_tie_sizes > 2)[0]:
        tied_players = order[row_index, : top_tie_sizes[row_index]]
        rapid_leaders = resolve_round_robin(tied_players, rapid_ratings, rng)
        if len(rapid_leaders) == 1:
            winners[row_index] = int(rapid_leaders[0])
            continue

        blitz_leaders = resolve_round_robin(rapid_leaders, blitz_ratings, rng)
        if len(blitz_leaders) == 1:
            winners[row_index] = int(blitz_leaders[0])
            continue

        winners[row_index] = resolve_knockout(blitz_leaders, blitz_ratings, rng)

    return winners


def rank_bucket_counts(order: np.ndarray, sorted_scores: np.ndarray, winners: np.ndarray) -> np.ndarray:
    batch_size, player_count = order.shape
    group_start = np.zeros((batch_size, player_count), dtype=np.int64)
    group_end = np.zeros((batch_size, player_count), dtype=np.int64)
    group_end[:, -1] = player_count - 1

    for index in range(1, player_count):
        group_start[:, index] = np.where(
            sorted_scores[:, index] == sorted_scores[:, index - 1],
            group_start[:, index - 1],
            index,
        )

    for index in range(player_count - 2, -1, -1):
        group_end[:, index] = np.where(
            sorted_scores[:, index] == sorted_scores[:, index + 1],
            group_end[:, index + 1],
            index,
        )

    group_size = group_end - group_start + 1
    bucket_counts = np.zeros((player_count, player_count), dtype=np.float64)

    for rank_index in range(player_count):
        contribution = np.where(
            (group_start <= rank_index) & (group_end >= rank_index),
            1.0 / group_size,
            0.0,
        )
        np.add.at(bucket_counts[:, rank_index], order.ravel(), contribution.ravel())

    top_tie_sizes = np.sum(sorted_scores == sorted_scores[:, [0]], axis=1)

    for row_index in np.where(top_tie_sizes > 1)[0]:
        tie_size = int(top_tie_sizes[row_index])
        tied_players = order[row_index, :tie_size]
        winner = int(winners[row_index])
        equal_share = 1.0 / tie_size

        for player_index in tied_players:
            bucket_counts[player_index, :tie_size] -= equal_share

        bucket_counts[winner, 0] += 1.0

        remaining_players = tied_players[tied_players != winner]
        if len(remaining_players):
            remaining_share = 1.0 / len(remaining_players)
            for player_index in remaining_players:
                bucket_counts[player_index, 1:tie_size] += remaining_share

    return bucket_counts


def seed_for_snapshot(data: dict, completed_round_count: int) -> int:
    seed_input = (
        f"{FORECAST_CACHE_VERSION}:{data['division']}:{data['snapshot_date']}:"
        f"{SIMULATION_COUNT}:{completed_round_count}"
    )
    return int(hashlib.sha256(seed_input.encode("utf-8")).hexdigest()[:16], 16)


def build_snapshot(data: dict, completed_round_count: int) -> dict:
    player_count = len(data["players"])
    player_names = [player["name"] for player in data["players"]]
    player_lookup = {player["name"]: player for player in data["players"]}
    name_to_index = {name: index for index, name in enumerate(player_names)}
    current_scores = np.zeros(player_count, dtype=np.float64)
    posterior_form = infer_posterior_form(data, completed_round_count, player_lookup)

    classical_ratings = np.array(
        [player["rating"] + posterior_form.get(player["name"], 0.0) for player in data["players"]],
        dtype=np.float64,
    )
    rapid_ratings = np.array(
        [
            (player.get("rapid_rating") or player["rating"]) + posterior_form.get(player["name"], 0.0)
            for player in data["players"]
        ],
        dtype=np.float64,
    )
    blitz_ratings = np.array(
        [
            (player.get("blitz_rating") or player.get("rapid_rating") or player["rating"])
            + posterior_form.get(player["name"], 0.0)
            for player in data["players"]
        ],
        dtype=np.float64,
    )

    remaining_games = []
    remaining_game_meta = []
    for round_index, round_data in enumerate(data["rounds"]):
        for game in round_data["pairings"]:
            result = game.get("result")
            should_treat_as_complete = (
                round_index < completed_round_count and result and result != "*"
            )
            white_index = name_to_index[game["white"]]
            black_index = name_to_index[game["black"]]

            if should_treat_as_complete:
                white_score, black_score = score_for_result(result)
                current_scores[white_index] += white_score
                current_scores[black_index] += black_score
                continue

            remaining_games.append(
                (
                    white_index,
                    black_index,
                    classical_ratings[white_index],
                    classical_ratings[black_index],
                )
            )
            remaining_game_meta.append(
                {
                    "roundNumber": round_index + 1,
                    "board": game["board"],
                    "white": game["white"],
                    "black": game["black"],
                }
            )

    rng = np.random.default_rng(seed_for_snapshot(data, completed_round_count))
    expected_score_sum = np.zeros(player_count, dtype=np.float64)
    win_counts = np.zeros(player_count, dtype=np.float64)
    rank_buckets = np.zeros((player_count, player_count), dtype=np.float64)
    pairing_odds_counts = np.zeros((len(remaining_games), 3), dtype=np.float64)

    processed = 0
    while processed < SIMULATION_COUNT:
        batch_size = min(CHUNK_SIZE, SIMULATION_COUNT - processed)
        scores, tracked_counts = simulate_scores_batch(
            current_scores,
            remaining_games,
            batch_size,
            rng,
            tracked_game_count=len(remaining_games),
        )
        expected_score_sum += scores.sum(axis=0)
        order = np.argsort(-scores, axis=1, kind="stable")
        sorted_scores = np.take_along_axis(scores, order, axis=1)
        winners = resolve_first_place_winners(order, sorted_scores, rapid_ratings, blitz_ratings, rng)
        win_counts += np.bincount(winners, minlength=player_count)
        rank_buckets += rank_bucket_counts(order, sorted_scores, winners)
        if tracked_counts is not None:
            pairing_odds_counts += tracked_counts
        processed += batch_size

    results = []
    for index, player in enumerate(data["players"]):
        rank_distribution = (rank_buckets[index] / SIMULATION_COUNT).tolist()
        expected_rank = sum(
            probability * (bucket_index + 1)
            for bucket_index, probability in enumerate(rank_distribution)
        )
        results.append(
            {
                "name": player["name"],
                "rating": player["rating"],
                "currentScore": float(current_scores[index]),
                "expectedScore": float(expected_score_sum[index] / SIMULATION_COUNT),
                "expectedRank": float(expected_rank),
                "winProbability": float(win_counts[index] / SIMULATION_COUNT),
                "rankDistribution": rank_distribution,
            }
        )

    results.sort(
        key=lambda player: (-player["winProbability"], player["expectedRank"])
    )

    pairing_odds_by_round: dict[str, list[dict]] = {}
    for game_index, meta in enumerate(remaining_game_meta):
        counts = pairing_odds_counts[game_index]
        round_key = str(meta["roundNumber"])
        pairing_odds_by_round.setdefault(round_key, []).append(
            {
                "board": meta["board"],
                "white": meta["white"],
                "black": meta["black"],
                "whiteWinProbability": float(counts[0] / SIMULATION_COUNT),
                "drawProbability": float(counts[1] / SIMULATION_COUNT),
                "blackWinProbability": float(counts[2] / SIMULATION_COUNT),
            }
        )

    pairing_odds = pairing_odds_by_round.get(str(completed_round_count + 1), [])

    return {
        "roundNumber": completed_round_count,
        "label": "0" if completed_round_count == 0 else str(completed_round_count),
        "results": results,
        "pairingOdds": pairing_odds,
        "pairingOddsByRound": pairing_odds_by_round,
        "isCompletedSnapshot": completed_round_count
        <= sum(1 for round_data in data["rounds"] if is_round_completed(round_data)),
    }


def build_forecast_payload(data: dict) -> dict:
    snapshots = [
        build_snapshot(data, completed_round_count)
        for completed_round_count in range(len(data["rounds"]) + 1)
    ]

    return {
        "division": data["division"],
        "snapshot_date": data["snapshot_date"],
        "simulation_count": SIMULATION_COUNT,
        "cache_version": FORECAST_CACHE_VERSION,
        "snapshots": snapshots,
    }


def main() -> None:
    for key, input_file in PAIRING_FILES.items():
        data = json.loads(input_file.read_text())
        forecast_payload = build_forecast_payload(data)
        FORECAST_FILES[key].write_text(
            json.dumps(forecast_payload, indent=2, ensure_ascii=True) + "\n"
        )


if __name__ == "__main__":
    main()
