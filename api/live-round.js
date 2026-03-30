const LIVE_CACHE_MS = 60 * 1000;
const memoryCache = new Map();

function badRequest(res, message) {
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

function parsePageData(html) {
  const match = html.match(
    /<script type="application\/json" id="page-init-data">([\s\S]*?)<\/script>/
  );

  if (!match) {
    throw new Error("Could not find page-init-data JSON");
  }

  return JSON.parse(match[1]);
}

function extractChapterMoveInfo(data) {
  const treeParts = data?.data?.treeParts ?? [];
  const lastPart = treeParts[treeParts.length - 1] ?? null;

  if (!lastPart || typeof lastPart !== "object") {
    return { lastMoveSan: null, ply: null };
  }

  return {
    lastMoveSan: typeof lastPart.san === "string" ? lastPart.san : null,
    ply: typeof lastPart.ply === "number" ? lastPart.ply : null,
  };
}

async function buildLiveGames(roundUrl, data) {
  const chapters = data?.study?.chapters ?? [];

  return Promise.all(
    chapters.map(async (chapter, index) => {
      const broadcastUrl = chapter.id ? `${roundUrl}/${chapter.id}` : roundUrl;
      let chapterMoveInfo = { lastMoveSan: null, ply: null };

      if (chapter.id) {
        try {
          const chapterResponse = await fetch(broadcastUrl, {
            headers: {
              "User-Agent": "candidates-2026-tracker",
            },
          });

          if (chapterResponse.ok) {
            const chapterHtml = await chapterResponse.text();
            chapterMoveInfo = extractChapterMoveInfo(parsePageData(chapterHtml));
          }
        } catch (_error) {
          // Ignore chapter-level fetch failures and fall back to raw UCI moves.
        }
      }

      return {
        board: index + 1,
        chapterId: chapter.id,
        white: chapter.players?.[0]?.name ?? null,
        black: chapter.players?.[1]?.name ?? null,
        fen: chapter.fen ?? null,
        lastMove: chapter.lastMove ?? null,
        lastMoveSan: chapterMoveInfo.lastMoveSan,
        ply: chapterMoveInfo.ply,
        result: chapter.status ?? "*",
        broadcastUrl,
      };
    })
  );
}

export default async function handler(req, res) {
  const roundUrl = req.query.roundUrl;

  if (!roundUrl || typeof roundUrl !== "string") {
    return badRequest(res, "Missing roundUrl");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(roundUrl);
  } catch (_error) {
    return badRequest(res, "Invalid roundUrl");
  }

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "lichess.org" ||
    !parsedUrl.pathname.startsWith("/broadcast/")
  ) {
    return badRequest(res, "roundUrl must be a lichess broadcast URL");
  }

  const cached = memoryCache.get(roundUrl);
  if (cached && Date.now() - cached.timestamp < LIVE_CACHE_MS) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.end(JSON.stringify(cached.payload));
  }

  try {
    const response = await fetch(roundUrl, {
      headers: {
        "User-Agent": "candidates-2026-tracker",
      },
    });

    if (!response.ok) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: `Upstream returned ${response.status}` }));
    }

    const html = await response.text();
    const data = parsePageData(html);
    const payload = {
      roundUrl,
      fetchedAt: new Date().toISOString(),
      games: await buildLiveGames(roundUrl, data),
    };

    memoryCache.set(roundUrl, {
      timestamp: Date.now(),
      payload,
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: error.message }));
  }
}
