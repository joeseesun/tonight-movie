// GET /api/hero-posters
// 返回一组经典电影的海报（经 /api/poster 代理），用于首页背景海报墙。
// 结果带边缘缓存，每天最多回源一次 OMDb。

const OMDB_BASE = "https://www.omdbapi.com/";

const HERO_IDS = [
  "tt0111161", // The Shawshank Redemption
  "tt0068646", // The Godfather
  "tt0468569", // The Dark Knight
  "tt1375666", // Inception
  "tt0109830", // Forrest Gump
  "tt0137523", // Fight Club
  "tt0110912", // Pulp Fiction
  "tt0120737", // The Lord of the Rings
  "tt0080684", // Star Wars: The Empire Strikes Back
  "tt0102926", // The Silence of the Lambs
  "tt0114369", // Se7en
  "tt0060196", // The Good, the Bad and the Ugly
];

function proxyPoster(rawUrl, size) {
  if (!rawUrl) return null;
  const resized = rawUrl.replace(/\._V1_[^.]*\.jpg$/i, `._V1_${size}.jpg`);
  return `/api/poster?u=${Buffer.from(resized).toString("base64url")}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).end();
    return;
  }
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) {
    res.status(200).json({ ok: true, posters: [] });
    return;
  }
  try {
    const settled = await Promise.allSettled(
      HERO_IDS.map(async (id) => {
        const r = await fetch(`${OMDB_BASE}?i=${id}&apikey=${apiKey}`);
        const d = await r.json();
        if (d?.Response === "False" || !d?.Poster || d.Poster === "N/A") return null;
        return { title: d.Title, poster: proxyPoster(d.Poster, "SX300") };
      })
    );
    const posters = settled
      .filter((s) => s.status === "fulfilled" && s.value)
      .map((s) => s.value);
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400");
    res.status(200).json({ ok: true, posters });
  } catch {
    res.status(200).json({ ok: true, posters: [] });
  }
}
