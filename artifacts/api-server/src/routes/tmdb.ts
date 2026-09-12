import { Router, type IRouter } from "express";

const router: IRouter = Router();
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_HOST = "image.tmdb.org";

/**
 * Stream TMDB artwork through the API server. The client uses this route as
 * its first-party image URL so poster requests do not depend on ISP access to
 * image.tmdb.org.
 */
router.get("/image", async (req, res) => {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    res.status(400).json({ error: "An image URL is required." });
    return;
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: "Invalid image URL." });
    return;
  }

  if (target.protocol !== "https:" || target.hostname !== TMDB_IMAGE_HOST) {
    res.status(400).json({ error: "Only TMDB image URLs are allowed." });
    return;
  }

  try {
    const response = await fetch(target, {
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      res.status(response.status).send("TMDB image unavailable.");
      return;
    }

    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const body = Buffer.from(await response.arrayBuffer());
    res.set({
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
    });
    res.send(body);
  } catch (error) {
    req.log.error({ err: error }, "TMDB image proxy request failed");
    res.status(502).send("TMDB image temporarily unavailable.");
  }
});

/**
 * Server-side TMDB proxy.
 *
 * The mobile bundle never receives TMDB_API_KEY. Only the API server reads the
 * secret and forwards the allow-listed TMDB path/query to TMDB.
 */
router.use("/tmdb", async (req, res) => {
  const apiKey = process.env.TMDB_API_KEY ?? process.env.TmDB;
  const endpoint = req.path;

  if (!apiKey) {
    res.status(503).json({ error: "TMDB is not configured on the API server." });
    return;
  }

  if (!endpoint.startsWith("/") || endpoint.includes("..") || endpoint.includes("//")) {
    res.status(400).json({ error: "Invalid TMDB endpoint." });
    return;
  }

  const target = new URL(`${TMDB_BASE_URL}${endpoint}`);
  target.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") target.searchParams.set(key, value);
  }

  try {
    const response = await fetch(target, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    const body = await response.text();
    res.status(response.status);
    res.type(response.headers.get("content-type") ?? "application/json");
    res.send(body);
  } catch (error) {
    req.log.error({ err: error, endpoint }, "TMDB proxy request failed");
    res.status(502).json({ error: "TMDB is temporarily unavailable." });
  }
});

export default router;