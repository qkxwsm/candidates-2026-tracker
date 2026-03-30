const { React } = window;
const { useEffect, useMemo, useState } = React;
const h = React.createElement;

const SIMULATION_COUNT = 100000;
const WHITE_ADVANTAGE_ELO = 35;
const DRAW_RATE_AT_EQUAL = 0.5;
const DRAW_DECAY_ELO = 300;
const ROUND_ZERO_KEY = "__round0__";
const SIMULATION_CACHE_VERSION = "v2";
const FORM_PRIOR_GAMES = 6;
const FORM_MAX_ELO_SHIFT = 120;
const PLAYER_PALETTE = [
  "#f6c35b",
  "#ff8a5b",
  "#63c7ff",
  "#90e39a",
  "#d7b3ff",
  "#ff7fa2",
  "#7fe0d2",
  "#f4f1de",
];
const PLAYER_COLORS = {
  "Caruana, Fabiano": "#f6c35b",
  "Nakamura, Hikaru": "#ff8a5b",
  "Praggnanandhaa R": "#63c7ff",
  "Giri, Anish": "#90e39a",
  "Bluebaum, Matthias": "#d7b3ff",
  "Wei, Yi": "#ff7fa2",
  "Sindarov, Javokhir": "#7fe0d2",
  "Esipenko, Andrey": "#f4f1de",
};

function playerColor(name, index = 0) {
  return PLAYER_COLORS[name] ?? PLAYER_PALETTE[index % PLAYER_PALETTE.length];
}

function simulationCacheKey(data, division) {
  return [
    "candidates-2026-tracker",
    SIMULATION_CACHE_VERSION,
    division,
    data.snapshot_date,
    SIMULATION_COUNT,
    WHITE_ADVANTAGE_ELO,
    DRAW_RATE_AT_EQUAL,
    DRAW_DECAY_ELO,
  ].join(":");
}

function formatResult(result) {
  if (result === "1/2-1/2") return "1/2-1/2";
  return result ?? "*";
}

function completedGames(pairings) {
  return pairings.filter((game) => game.result && game.result !== "*").length;
}

function isRoundCompleted(round) {
  return round.pairings.every((game) => game.result && game.result !== "*");
}

function externalLink(label, href) {
  return h(
    "a",
    { href, target: "_blank", rel: "noreferrer" },
    label
  );
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatScore(value) {
  return value.toFixed(2);
}

function formatCurrentScore(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatStandingScore(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatRank(value) {
  return value.toFixed(2);
}

function probabilityModel(white, black) {
  const adjustedDelta = white.rating + WHITE_ADVANTAGE_ELO - black.rating;
  const expectedWhite = 1 / (1 + 10 ** (-adjustedDelta / 400));
  const drawCap = 2 * Math.min(expectedWhite, 1 - expectedWhite);
  const drawProbability = Math.min(
    DRAW_RATE_AT_EQUAL * Math.exp(-Math.abs(adjustedDelta) / DRAW_DECAY_ELO),
    drawCap
  );
  const whiteWinProbability = expectedWhite - drawProbability / 2;
  const blackWinProbability = 1 - whiteWinProbability - drawProbability;

  return {
    expectedWhite,
    whiteWinProbability,
    drawProbability,
    blackWinProbability,
  };
}

function expectedScoreForPlayer(player, opponent, isWhite, formDelta = 0) {
  if (isWhite) {
    return probabilityModel(
      { ...player, rating: player.rating + formDelta },
      opponent
    ).expectedWhite;
  }

  return 1 - probabilityModel(
    opponent,
    { ...player, rating: player.rating + formDelta }
  ).expectedWhite;
}

function scoreForResult(result) {
  if (result === "1-0") return [1, 0];
  if (result === "0-1") return [0, 1];
  if (result === "1/2-1/2") return [0.5, 0.5];
  return [0, 0];
}

function standingsThroughRound(data, completedRoundCount) {
  const scores = new Map(data.players.map((player) => [player.name, 0]));

  data.rounds.slice(0, completedRoundCount).forEach((round) => {
    round.pairings.forEach((game) => {
      if (!game.result || game.result === "*") return;
      const [whiteScore, blackScore] = scoreForResult(game.result);
      scores.set(game.white, scores.get(game.white) + whiteScore);
      scores.set(game.black, scores.get(game.black) + blackScore);
    });
  });

  return data.players
    .map((player) => ({
      name: player.name,
      score: scores.get(player.name),
      rating: player.rating,
    }))
    .sort((left, right) => right.score - left.score || right.rating - left.rating);
}

function inferPosteriorForm(data, completedRoundCount, playerLookup) {
  const playerGames = new Map(
    data.players.map((player) => [
      player.name,
      {
        player,
        games: [],
        actualScore: 0,
      },
    ])
  );

  data.rounds.slice(0, completedRoundCount).forEach((round) => {
    round.pairings.forEach((game) => {
      if (!game.result || game.result === "*") return;

      const [whiteScore, blackScore] = scoreForResult(game.result);
      const whitePlayer = playerLookup.get(game.white);
      const blackPlayer = playerLookup.get(game.black);

      playerGames.get(game.white).games.push({
        opponent: blackPlayer,
        isWhite: true,
        actualScore: whiteScore,
      });
      playerGames.get(game.white).actualScore += whiteScore;

      playerGames.get(game.black).games.push({
        opponent: whitePlayer,
        isWhite: false,
        actualScore: blackScore,
      });
      playerGames.get(game.black).actualScore += blackScore;
    });
  });

  const formMap = new Map();

  playerGames.forEach(({ player, games, actualScore }, name) => {
    if (!games.length) {
      formMap.set(name, 0);
      return;
    }

    let low = -FORM_MAX_ELO_SHIFT;
    let high = FORM_MAX_ELO_SHIFT;

    for (let iteration = 0; iteration < 24; iteration += 1) {
      const mid = (low + high) / 2;
      const expectedTotal = games.reduce(
        (total, game) =>
          total + expectedScoreForPlayer(player, game.opponent, game.isWhite, mid),
        0
      );

      if (expectedTotal < actualScore) {
        low = mid;
      } else {
        high = mid;
      }
    }

    const rawShift = (low + high) / 2;
    const shrink = games.length / (games.length + FORM_PRIOR_GAMES);
    formMap.set(name, rawShift * shrink);
  });

  return formMap;
}

function buildSimulation(data, completedRoundCount) {
  const playerLookup = new Map(data.players.map((player) => [player.name, player]));
  const currentScores = new Map(data.players.map((player) => [player.name, 0]));
  const remainingGames = [];
  const posteriorForm = inferPosteriorForm(data, completedRoundCount, playerLookup);

  data.rounds.forEach((round, roundIndex) => {
    round.pairings.forEach((game) => {
      const shouldTreatAsComplete =
        roundIndex < completedRoundCount && game.result && game.result !== "*";

      if (shouldTreatAsComplete) {
        const [whiteScore, blackScore] = scoreForResult(game.result);
        currentScores.set(game.white, currentScores.get(game.white) + whiteScore);
        currentScores.set(game.black, currentScores.get(game.black) + blackScore);
        return;
      }

      remainingGames.push({
        white: {
          ...playerLookup.get(game.white),
          rating:
            playerLookup.get(game.white).rating + (posteriorForm.get(game.white) ?? 0),
        },
        black: {
          ...playerLookup.get(game.black),
          rating:
            playerLookup.get(game.black).rating + (posteriorForm.get(game.black) ?? 0),
        },
      });
    });
  });

  const stats = new Map(
    data.players.map((player) => [
      player.name,
      {
        name: player.name,
        rating: player.rating,
        currentScore: currentScores.get(player.name),
        expectedScoreSum: 0,
        winShares: 0,
        rankBuckets: Array(data.players.length).fill(0),
      },
    ])
  );

  for (let iteration = 0; iteration < SIMULATION_COUNT; iteration += 1) {
    const scores = new Map(currentScores);

    remainingGames.forEach((game) => {
      const probabilities = probabilityModel(game.white, game.black);
      const draw = Math.random();

      if (draw < probabilities.whiteWinProbability) {
        scores.set(game.white.name, scores.get(game.white.name) + 1);
      } else if (
        draw <
        probabilities.whiteWinProbability + probabilities.drawProbability
      ) {
        scores.set(game.white.name, scores.get(game.white.name) + 0.5);
        scores.set(game.black.name, scores.get(game.black.name) + 0.5);
      } else {
        scores.set(game.black.name, scores.get(game.black.name) + 1);
      }
    });

    const ranking = data.players
      .map((player) => ({
        name: player.name,
        score: scores.get(player.name),
      }))
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

    ranking.forEach((entry) => {
      stats.get(entry.name).expectedScoreSum += entry.score;
    });

    let index = 0;
    while (index < ranking.length) {
      let groupEnd = index + 1;
      while (
        groupEnd < ranking.length &&
        ranking[groupEnd].score === ranking[index].score
      ) {
        groupEnd += 1;
      }

      const tiedGroup = ranking.slice(index, groupEnd);
      const startRank = index + 1;
      const endRank = groupEnd;
      const tieShare = 1 / tiedGroup.length;

      tiedGroup.forEach((entry) => {
        const stat = stats.get(entry.name);

        for (let rank = startRank; rank <= endRank; rank += 1) {
          stat.rankBuckets[rank - 1] += tieShare;
        }

        if (startRank === 1) {
          stat.winShares += tieShare;
        }
      });

      index = groupEnd;
    }
  }

  return Array.from(stats.values())
    .map((stat) => {
      const rankDistribution = stat.rankBuckets.map(
        (bucket) => bucket / SIMULATION_COUNT
      );
      const expectedRank = rankDistribution.reduce(
        (total, probability, bucketIndex) => total + probability * (bucketIndex + 1),
        0
      );

      return {
        ...stat,
        expectedScore: stat.expectedScoreSum / SIMULATION_COUNT,
        expectedRank,
        winProbability: stat.winShares / SIMULATION_COUNT,
        rankDistribution,
      };
    })
    .sort(
      (left, right) =>
        right.winProbability - left.winProbability ||
        left.expectedRank - right.expectedRank
    );
}

function mergeSimulationTables(beforeRound, afterRound) {
  return afterRound;
}

function buildRoundSimulations(data) {
  const completedRoundTotal = data.rounds.filter(isRoundCompleted).length;
  const roundSnapshots = [];

  for (let completedRoundCount = 0; completedRoundCount <= data.rounds.length; completedRoundCount += 1) {
    roundSnapshots.push({
      roundNumber: completedRoundCount,
      label: completedRoundCount === 0 ? "0" : `${completedRoundCount}`,
      results: buildSimulation(data, completedRoundCount),
      isCompletedSnapshot: completedRoundCount <= completedRoundTotal,
    });
  }

  return roundSnapshots;
}

function buildWinProbabilityHistory(data, roundSnapshots) {
  const completedSnapshots = roundSnapshots.filter((snapshot) => snapshot.isCompletedSnapshot);

  return data.players.map((player, index) => ({
    name: player.name,
    color: playerColor(player.name, index),
    points: completedSnapshots.map((snapshot, index) => ({
      x: index,
      label: snapshot.label,
      value:
        snapshot.results.find((entry) => entry.name === player.name)?.winProbability ?? 0,
    })),
  }));
}

function buildTicks(minValue, maxValue, count) {
  if (count <= 1) return [minValue];
  const step = (maxValue - minValue) / (count - 1);
  return Array.from({ length: count }, (_, index) => minValue + step * index);
}

function HistoryChart({ series }) {
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const width = 960;
  const height = 360;
  const margin = { top: 24, right: 22, bottom: 52, left: 54 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const stepCount = Math.max((series[0]?.points.length ?? 1) - 1, 1);
  const axisLabels = series[0]?.points ?? [];
  const values = series.flatMap((player) => player.points.map((point) => point.value));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.12, 0.02);
  const yMin = Math.max(0, rawMin - padding);
  const yMax = Math.min(1, rawMax + padding);
  const safeYMax = yMax === yMin ? Math.min(1, yMin + 0.05) : yMax;
  const yTicks = buildTicks(yMin, safeYMax, 5);

  function xScale(index) {
    return margin.left + (innerWidth * index) / stepCount;
  }

  function yScale(value) {
    const ratio = (value - yMin) / (safeYMax - yMin);
    return margin.top + innerHeight - innerHeight * ratio;
  }

  const tooltip = hoveredPoint
    ? (() => {
        const tooltipWidth = 148;
        const tooltipHeight = 54;
        const x = Math.min(
          Math.max(hoveredPoint.cx - tooltipWidth / 2, margin.left + 4),
          width - margin.right - tooltipWidth
        );
        const y = Math.max(hoveredPoint.cy - tooltipHeight - 14, margin.top + 4);
        return { ...hoveredPoint, x, y, width: tooltipWidth, height: tooltipHeight };
      })()
    : null;

  return h(
    React.Fragment,
    null,
    h(
      "svg",
      {
        className: "history-chart",
        viewBox: `0 0 ${width} ${height}`,
        role: "img",
        "aria-label": "Tournament win probability by round",
        onMouseLeave: () => setHoveredPoint(null),
      },
      h(
        "g",
        { className: "chart-grid" },
        ...yTicks.map((tick) =>
          h("line", {
            key: `grid-${tick}`,
            x1: margin.left,
            x2: width - margin.right,
            y1: yScale(tick),
            y2: yScale(tick),
          })
        )
      ),
      h(
        "g",
        { className: "chart-axis" },
        h("line", {
          x1: margin.left,
          x2: width - margin.right,
          y1: height - margin.bottom,
          y2: height - margin.bottom,
        }),
        h("line", {
          x1: margin.left,
          x2: margin.left,
          y1: margin.top,
          y2: height - margin.bottom,
        }),
        ...axisLabels.map((point, index) =>
          h(
            "g",
            { key: `x-axis-${point.label}` },
            h("line", {
              x1: xScale(index),
              x2: xScale(index),
              y1: height - margin.bottom,
              y2: height - margin.bottom + 6,
            }),
            h(
              "text",
              {
                x: xScale(index),
                y: height - margin.bottom + 22,
                textAnchor: "middle",
              },
              point.label
            )
          )
        ),
        ...yTicks.map((tick) =>
          h(
            "g",
            { key: `y-axis-${tick}` },
            h("line", {
              x1: margin.left - 6,
              x2: margin.left,
              y1: yScale(tick),
              y2: yScale(tick),
            }),
            h(
              "text",
              {
                x: margin.left - 10,
                y: yScale(tick) + 4,
                textAnchor: "end",
              },
              formatPercent(tick)
            )
          )
        ),
        h(
          "text",
          {
            x: width - margin.right,
            y: height - 10,
            textAnchor: "end",
            className: "chart-axis-label",
          },
          "Round"
        )
      ),
      ...series.map((player) =>
        h(
          "g",
          { key: `line-${player.name}` },
          h("path", {
            className: "chart-line",
            d: player.points
              .map((point, index) => `${index === 0 ? "M" : "L"} ${xScale(point.x)} ${yScale(point.value)}`)
              .join(" "),
            stroke: player.color,
          }),
          ...player.points.map((point) => {
            const cx = xScale(point.x);
            const cy = yScale(point.value);
            const active =
              hoveredPoint &&
              hoveredPoint.playerName === player.name &&
              hoveredPoint.label === point.label;

            return h(
              "g",
              { key: `${player.name}-${point.label}` },
              h("circle", {
                className: active ? "chart-point active" : "chart-point",
                cx,
                cy,
                r: active ? 5 : 3.5,
                fill: player.color,
              }),
              h("circle", {
                className: "chart-hit-area",
                cx,
                cy,
                r: 11,
                onMouseEnter: () =>
                  setHoveredPoint({
                    playerName: player.name,
                    label: point.label,
                    value: point.value,
                    color: player.color,
                    cx,
                    cy,
                  }),
              })
            );
          })
        )
      ),
      tooltip
        ? h(
            "g",
            { className: "chart-tooltip", pointerEvents: "none" },
            h("rect", {
              x: tooltip.x,
              y: tooltip.y,
              width: tooltip.width,
              height: tooltip.height,
              rx: 12,
            }),
            h("circle", {
              cx: tooltip.x + 14,
              cy: tooltip.y + 16,
              r: 4,
              fill: tooltip.color,
            }),
            h(
              "text",
              { x: tooltip.x + 24, y: tooltip.y + 20, className: "chart-tooltip-title" },
              tooltip.playerName
            ),
            h(
              "text",
              { x: tooltip.x + 14, y: tooltip.y + 38, className: "chart-tooltip-body" },
              `${tooltip.label}: ${formatPercent(tooltip.value)}`
            )
          )
        : null
    )
  );
}

export function App() {
  const [datasets, setDatasets] = useState(null);
  const [selectedDivision, setSelectedDivision] = useState("Open");
  const [activeRound, setActiveRound] = useState("");
  const [roundSimulations, setRoundSimulations] = useState(null);
  const [historySeries, setHistorySeries] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch("./data/open_pairings.json").then((response) => response.json()),
      fetch("./data/women_pairings.json").then((response) => response.json()),
    ]).then(([openData, womenData]) => {
      setDatasets({
        Open: { ...openData, division: "Open", event: "FIDE Candidates 2026" },
        Women: womenData,
      });
    });
  }, []);

  const data = useMemo(() => {
    if (!datasets) return null;
    return datasets[selectedDivision] ?? null;
  }, [datasets, selectedDivision]);

  useEffect(() => {
    if (!data) return;
    const completedRounds = data.rounds.filter(isRoundCompleted);
    const defaultRound = completedRounds[completedRounds.length - 1] ?? null;
    setActiveRound(defaultRound?.name ?? ROUND_ZERO_KEY);
  }, [data]);

  const round = useMemo(() => {
    if (!data) return null;
    if (activeRound === ROUND_ZERO_KEY) return null;
    return data.rounds.find((entry) => entry.name === activeRound) ?? null;
  }, [activeRound, data]);

  const activeRoundIndex = useMemo(() => {
    if (!data || !round) return -1;
    return data.rounds.findIndex((entry) => entry.name === round.name);
  }, [data, round]);

  const completedRounds = useMemo(() => {
    if (!data) return [];
    return data.rounds.filter(isRoundCompleted);
  }, [data]);

  const latestCompletedRound = completedRounds[completedRounds.length - 1] ?? null;

  const playersByRating = useMemo(() => {
    if (!data) return [];
    return [...data.players].sort((left, right) => right.rating - left.rating);
  }, [data]);
  const nextRoundIndex = completedRounds.length;

  const playerRatings = useMemo(() => {
    if (!data) return new Map();
    return new Map(data.players.map((player) => [player.name, player.rating]));
  }, [data]);

  const scoresBeforeSelectedRound = useMemo(() => {
    if (!data) return new Map();
    const standings = standingsThroughRound(data, Math.max(activeRoundIndex, 0));
    return new Map(standings.map((player) => [player.name, player.score]));
  }, [activeRoundIndex, data]);

  const completedGamesByPlayer = useMemo(() => {
    if (!data) return new Map();

    const counts = new Map(data.players.map((player) => [player.name, 0]));

    data.rounds.slice(0, activeRoundIndex + 1).forEach((roundEntry) => {
      roundEntry.pairings.forEach((game) => {
        if (!game.result || game.result === "*") return;
        counts.set(game.white, (counts.get(game.white) ?? 0) + 1);
        counts.set(game.black, (counts.get(game.black) ?? 0) + 1);
      });
    });

    return counts;
  }, [activeRoundIndex, data]);

  const showPairingScores =
    !!round && (isRoundCompleted(round) || activeRoundIndex === nextRoundIndex);

  const forecastRows = useMemo(() => {
    if (!roundSimulations || roundSimulations.division !== selectedDivision) return null;
    const snapshot = roundSimulations.snapshots.find(
      (entry) => entry.roundNumber === Math.max(activeRoundIndex + 1, 0)
    );
    return snapshot ? mergeSimulationTables([], snapshot.results) : null;
  }, [activeRoundIndex, roundSimulations, selectedDivision]);

  const selectedRoundWinRows = useMemo(() => {
    if (!forecastRows) return null;
    return new Map(
      forecastRows.map((player) => [player.name, player.winProbability])
    );
  }, [forecastRows]);

  const legendSeries = useMemo(() => {
    if (!historySeries || historySeries.division !== selectedDivision) return [];
    if (!selectedRoundWinRows) return historySeries.series;

    return [...historySeries.series].sort(
      (left, right) =>
        (selectedRoundWinRows.get(right.name) ?? 0) -
        (selectedRoundWinRows.get(left.name) ?? 0)
    );
  }, [historySeries, selectedRoundWinRows, selectedDivision]);

  const visibleHistorySeries = useMemo(() => {
    if (!legendSeries.length) return [];

    return legendSeries.map((player) => ({
      ...player,
      points: player.points.filter((point) => Number(point.label) <= Math.max(activeRoundIndex + 1, 0)),
    }));
  }, [activeRoundIndex, legendSeries]);

  useEffect(() => {
    if (!data) return;

    setRoundSimulations(null);
    setHistorySeries(null);
    const timer = window.setTimeout(() => {
      const cacheKey = simulationCacheKey(data, selectedDivision);

      try {
        const cached = window.localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          setRoundSimulations({
            division: selectedDivision,
            snapshots: parsed.snapshots,
          });
          setHistorySeries({
            division: selectedDivision,
            series: parsed.historySeries,
          });
          return;
        }
      } catch (_error) {
        // Ignore cache read failures and recompute below.
      }

      const snapshots = buildRoundSimulations(data);
      const series = buildWinProbabilityHistory(data, snapshots);

      try {
        window.localStorage.setItem(
          cacheKey,
          JSON.stringify({
            snapshots,
            historySeries: series,
          })
        );
      } catch (_error) {
        // Ignore cache write failures and keep the in-memory results.
      }

      setRoundSimulations({
        division: selectedDivision,
        snapshots,
      });
      setHistorySeries({
        division: selectedDivision,
        series,
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [data, selectedDivision]);

  if (!data) {
    return h(
      "div",
      { className: "page-shell" },
      h(
        "main",
        { className: "app-card loading-state" },
        h("p", { className: "eyebrow" }, "Loading"),
        h("h1", null, "Candidates 2026 Tracker"),
        h("p", { className: "lede" }, "Fetching the latest local snapshot.")
      )
    );
  }

  return h(
    "div",
    { className: "page-shell" },
    h(
      "main",
      { className: "app-card", key: selectedDivision },
      h(
        "section",
        { className: "hero" },
        h("h1", null, "FIDE Candidates 2026 Tracker"),
        h(
          "div",
          { className: "division-toggle", role: "tablist", "aria-label": "Division" },
          ...["Open", "Women"].map((division) =>
            h(
              "button",
              {
                key: division,
                type: "button",
                className: division === selectedDivision ? "division-tab active" : "division-tab",
                onClick: () => setSelectedDivision(division),
              },
              division
            )
          )
        )
      ),
      h(
        "section",
        { className: "players-panel" },
        h(
          "div",
          { className: "rounds-header" },
          h(
            "div",
            null,
            h("p", { className: "section-kicker" }, "Players")
          )
        ),
        h(
          "div",
          { className: "players-grid" },
          ...playersByRating.map((player) =>
            h(
              "span",
              { key: player.name, className: "player-pill" },
              h("strong", { className: "player-name" }, player.name),
              h("span", { className: "player-rating" }, player.rating)
            )
          )
        )
      ),
      h(
        "section",
        { className: "simulation-panel" },
        h(
          "div",
          { className: "round-filter-bar" },
          h("label", { htmlFor: "round-selector", className: "distribution-label" }, "Show data after round"),
          h(
            "select",
            {
              id: "round-selector",
              className: "distribution-select",
              value: activeRound,
              onChange: (event) => setActiveRound(event.target.value),
            },
            h(
              "option",
              { value: ROUND_ZERO_KEY },
              "Round 0 (before tournament)"
            ),
            ...data.rounds.map((entry) =>
              h(
                "option",
                { key: `round-option-${entry.name}`, value: entry.name },
                `${entry.name}${isRoundCompleted(entry) ? " (completed)" : ""}`
              )
            )
          )
        )
      ),
      h(
        "section",
        { className: "simulation-panel" },
        h(
          "div",
          { className: "rounds-header" },
          h(
            "div",
            null,
            h("p", { className: "section-kicker" }, "Tournament Win Probability")
          )
        ),
        !historySeries || historySeries.division !== selectedDivision
          ? h(
              "div",
              { className: "simulation-loading" },
              "Building the history chart..."
            )
          : h(
              "div",
              { className: "history-block" },
              h(
                "div",
                { className: "chart-wrap" },
                h(HistoryChart, { series: visibleHistorySeries })
              ),
              h(
                "div",
                { className: "chart-legend" },
                ...legendSeries.map((player) =>
                  h(
                    "div",
                    { key: `legend-${player.name}`, className: "legend-item" },
                    h("span", {
                      className: "legend-swatch",
                      style: { backgroundColor: player.color },
                    }),
                    h(
                      "span",
                      { className: "legend-text" },
                      player.name,
                      selectedRoundWinRows
                        ? ` (${formatPercent(selectedRoundWinRows.get(player.name) ?? 0)})`
                        : ""
                    )
                  )
                )
              )
            )
      ),
      h(
        "section",
        { className: "rounds-panel" },
        h(
          "div",
          { className: "rounds-header" },
          h(
            "div",
            null,
            null,
            h("p", { className: "section-kicker" }, "Pairings"),
            round
              ? h(
                  "div",
                  { className: "round-summary" },
                  `${round.name} ◆ ${completedGames(round.pairings)} of ${round.pairings.length} games finished`
                )
              : h(
                  "div",
                  { className: "round-summary" },
                  "Round 0 (before tournament)"
                )
          )
        ),
        round
          ? h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "table-wrap" },
                h(
                  "table",
                  null,
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", null, "Board"),
                      h("th", null, "White Rating"),
                      h("th", null, "White"),
                      h("th", null, "Result"),
                      h("th", null, "Black"),
                      h("th", null, "Black Rating")
                    )
                  ),
                  h(
                    "tbody",
                    null,
                    ...round.pairings.map((game) =>
                      h(
                        "tr",
                        { key: `${round.name}-${game.board}` },
                        h("td", null, game.board),
                        h("td", null, playerRatings.get(game.white) ?? "-"),
                        h(
                          "td",
                          null,
                          showPairingScores
                            ? `${game.white} (${formatStandingScore(
                                scoresBeforeSelectedRound.get(game.white) ?? 0
                              )})`
                            : game.white
                        ),
                        h(
                          "td",
                          {
                            className:
                              game.result === "*" ? "pending-result" : "final-result",
                          },
                          formatResult(game.result)
                        ),
                        h(
                          "td",
                          null,
                          showPairingScores
                            ? `${game.black} (${formatStandingScore(
                                scoresBeforeSelectedRound.get(game.black) ?? 0
                              )})`
                            : game.black
                        ),
                        h("td", null, playerRatings.get(game.black) ?? "-")
                      )
                    )
                  )
                )
              )
            )
          : h(
              "div",
              { className: "simulation-loading" },
              "No pairings to show before the tournament begins."
            )
      ),
      h(
        "section",
        { className: "simulation-panel" },
        h(
          "div",
          { className: "rounds-header" },
          h(
            "div",
            null,
            h("p", { className: "section-kicker" }, "Forecast Detail")
          )
        ),
        !forecastRows
          ? h(
              "div",
              { className: "simulation-loading" },
              "Running the forecast..."
            )
          : h(
              React.Fragment,
              null,
              h("h3", { className: "subsection-title" }, "Stats"),
              h(
                "div",
                { className: "table-wrap simulation-table" },
                h(
                  "table",
                  { className: "stats-table" },
                  h(
                    "colgroup",
                    null,
                    h("col", { className: "stats-col-player" }),
                    h("col", { className: "stats-col-thin" }),
                    h("col", { className: "stats-col-thin" }),
                    h("col", { className: "stats-col-thin" }),
                    h("col", { className: "stats-col-metric" }),
                    h("col", { className: "stats-col-metric" }),
                    h("col", { className: "stats-col-metric" })
                  ),
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", null, "Player"),
                      h("th", null, "Rating"),
                      h("th", null, "Games"),
                      h("th", null, "Score"),
                      h("th", null, "Expected Final Score"),
                      h("th", null, "Expected Final Rank"),
                      h("th", null, "Tournament Win Probability")
                    )
                  ),
                  h(
                    "tbody",
                    null,
                    ...forecastRows.map((player) =>
                      h(
                        "tr",
                        { key: `summary-${player.name}` },
                        h("td", null, player.name),
                        h("td", null, player.rating),
                        h("td", null, completedGamesByPlayer.get(player.name) ?? 0),
                        h("td", null, formatCurrentScore(player.currentScore)),
                        h("td", null, formatScore(player.expectedScore)),
                        h("td", null, formatRank(player.expectedRank)),
                        h("td", { className: "final-result" }, formatPercent(player.winProbability))
                      )
                    )
                  )
                )
              ),
              h(
                "div",
                { className: "simulation-table distribution-table" },
              h("h3", { className: "subsection-title" }, "Expected Ranking Distribution"),
                h(
                  "div",
                  { className: "distribution-grid" },
                  ...forecastRows.map((player) =>
                    h(
                      "section",
                      { key: `distribution-${player.name}`, className: "distribution-card" },
                      h("h3", { className: "distribution-player" }, player.name),
                      h(
                        "div",
                        { className: "distribution-bars" },
                        ...player.rankDistribution.map((probability, index) =>
                          h(
                            "div",
                            {
                              key: `${player.name}-rank-${index + 1}`,
                              className: "distribution-bar-row",
                            },
                            h("span", { className: "distribution-rank" }, `${index + 1}`),
                            h(
                              "div",
                              { className: "distribution-bar-track" },
                              h("div", {
                                className: "distribution-bar-fill",
                                style: {
                                  height: `${Math.max(probability * 100, probability > 0 ? 1.5 : 0)}%`,
                                  backgroundColor: playerColor(player.name, data.players.findIndex((entry) => entry.name === player.name)),
                                },
                              })
                            ),
                            h(
                              "span",
                              { className: "distribution-value" },
                              formatPercent(probability)
                            )
                          )
                        )
                      )
                    )
                  )
                )
              ),
              h(
                "details",
                { className: "show-more" },
                h("summary", null, "Show info"),
                h(
                  "div",
                  { className: "show-more-content" },
                  h(
                    "p",
                    { className: "model-note info-intro" },
                    "Round-by-round pairings and results from the Lichess broadcast."
                  ),
                  h(
                    "p",
                    { className: "model-note info-paragraph" },
                    "Probabilities are generated using 100,000 Monte Carlo runs with a 35 Elo white-edge assumption, FIDE expected score as the base signal, a draw model that starts at 50% for equal-strength players and decays as the rating gap grows, and a posterior form adjustment inferred from completed games."
                  ),
                  h(
                    "div",
                    { className: "distribution-description" },
                    "Ranking distribution shows the simulated probability that each player finishes in each final place, from first through eighth, after the selected round snapshot."
                  ),
                  h(
                    "p",
                    { className: "model-note info-paragraph" },
                    "This forecast also infers a posterior form adjustment from completed games. In plain terms, players who have already outperformed expectation are given a modest upward strength shift for the remaining simulations, while players who have underperformed are shifted downward. The adjustment is shrunk toward zero so a small number of games does not overreact. This is a simplified tournament-specific version of ideas from dynamic rating models such as Glicko and other time-varying paired-comparison methods."
                  ),
                  h(
                    "div",
                    { className: "source-links-block" },
                    h("span", { className: "source-links-heading" }, "Tournament"),
                    h(
                      "div",
                      { className: "source-links-row" },
                      externalLink("Official site", data.website),
                      externalLink("Lichess broadcast", data.source)
                    )
                  ),
                  h(
                    "div",
                    { className: "source-links-block" },
                    h("span", { className: "source-links-heading" }, "Model inputs"),
                    h(
                      "div",
                      { className: "source-links-row" },
                      externalLink("FIDE expected score table", "https://handbook.fide.com/chapter/B022024"),
                      externalLink("Draw model background", "https://doi.org/10.1515/jqas-2019-0102"),
                      externalLink("White-advantage study", "https://pmc.ncbi.nlm.nih.gov/articles/PMC3559554/")
                    )
                  ),
                  h(
                    "div",
                    { className: "source-links-block" },
                    h("span", { className: "source-links-heading" }, "Related literature"),
                    h(
                      "div",
                      { className: "source-links-row" },
                      externalLink("Glickman research", "https://glicko.net/research.html"),
                      externalLink("Time-varying paired-comparison model", "https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0251945")
                    )
                  )
                )
              )
            )
      ),
    )
  );
}
