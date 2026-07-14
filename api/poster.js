// GET /api/poster?u=<base64url 编码的海报 URL>
// 代理 Amazon 海报图床，解决部分地区 m.media-amazon.com 不可达的问题。
// 只允许白名单图床域名，响应带长缓存。

const ALLOWED_HOSTS = new Set(["m.media-amazon.com", "ia.media-imdb.com"]);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).end();
    return;
  }
  try {
    const encoded = String(req.query?.u || "");
    const url = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
      res.status(400).json({ ok: false, error: "invalid poster url" });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const upstream = await fetch(parsed.toString(), { signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) {
      res.status(upstream.status === 404 ? 404 : 502).end();
      return;
    }
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(200).send(buf);
  } catch {
    res.status(502).end();
  }
}
