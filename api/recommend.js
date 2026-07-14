// POST /api/recommend  { query: "我想看一部高分悬疑片" }
// Pipeline: Deepseek v4 Flash 意图解析 -> OMDb 检索(t=/s=) -> 详情补全 -> 评分筛选排序 -> 卡片数据

const OMDB_BASE = "https://www.omdbapi.com/";
const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

const RESULT_LIMIT = 12;
const MIN_RESULTS_BEFORE_RELAX = 6;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fetchJSON(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.json();
    })
    .finally(() => clearTimeout(timer));
}

// ---------- 1. Deepseek 意图解析 ----------

const INTENT_PROMPT = `你是观影意图解析器。用户用自然语言描述想看的电影或剧集，你要输出一个 JSON 检索计划，供后端调用 OMDb API。
只输出 JSON，不要输出任何解释文字。

JSON 结构：
{
  "titles": ["英文原片名1", "英文原片名2"],
  "keywords": ["英文标题关键词"],
  "min_rating": 7.5,
  "year_from": null,
  "year_to": null,
  "media_type": "movie",
  "summary": "一句话中文复述用户想看什么"
}

字段规则：
- titles: 8 到 10 部你确定真实存在、符合需求且口碑好的具体影片，必须是英文原片名（例如 "The Shawshank Redemption"，不要中文译名）。用于 OMDb t= 精确查询。宁缺毋滥，但尽量给满 8 部以上。
- keywords: 0 到 2 个英文标题关键词，用于 OMDb s= 模糊搜索补充发现。可以是演员姓、导演姓、系列名或题材词。
- min_rating: IMDb 最低分。用户说"高分/好片"必须用 7.5，说"经典/神作"必须用 8.0，用户给了具体分数就用具体分数，完全没提评分才用 6.5。
- year_from / year_to: 数字年份或 null。用户提到年代时填写（如"90年代" -> 1990 到 1999）。
- media_type: "movie"、"series" 或 null。用户说剧/剧集用 "series"，默认 "movie"。
- 若用户指定地区、演员、导演、题材，titles 必须严格遵守。`;

async function parseIntent(query, apiKey) {
  const fallback = {
    titles: [],
    keywords: [query],
    min_rating: 7.5,
    year_from: null,
    year_to: null,
    media_type: "movie",
    summary: `直接搜索：${query}`,
  };
  if (!apiKey) return fallback;
  try {
    const data = await fetchJSON(
      `${DEEPSEEK_BASE}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          temperature: 0.3,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: INTENT_PROMPT },
            { role: "user", content: query },
          ],
        }),
      },
      20000
    );
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return fallback;
    const plan = JSON.parse(content);
    return {
      titles: Array.isArray(plan.titles) ? plan.titles.slice(0, 10) : [],
      keywords: Array.isArray(plan.keywords) ? plan.keywords.slice(0, 2) : [],
      min_rating:
        typeof plan.min_rating === "number" && plan.min_rating >= 5 && plan.min_rating <= 9.5
          ? plan.min_rating
          : 7.5,
      year_from: Number.isFinite(plan.year_from) ? plan.year_from : null,
      year_to: Number.isFinite(plan.year_to) ? plan.year_to : null,
      media_type: plan.media_type === "series" ? "series" : plan.media_type === "movie" ? "movie" : null,
      summary: typeof plan.summary === "string" && plan.summary.trim() ? plan.summary.trim() : fallback.summary,
    };
  } catch {
    return fallback;
  }
}

// ---------- 2. OMDb 检索 ----------

function omdbURL(params, apiKey) {
  const qs = new URLSearchParams({ ...params, apikey: apiKey });
  return `${OMDB_BASE}?${qs.toString()}`;
}

function proxyPoster(rawUrl, size) {
  if (!rawUrl) return null;
  const resized = rawUrl.replace(/\._V1_[^.]*\.jpg$/i, `._V1_${size}.jpg`);
  return `/api/poster?u=${Buffer.from(resized).toString("base64url")}`;
}

function normalizeMovie(raw) {
  if (!raw || raw.Response === "False") return null;
  const rating = parseFloat(raw.imdbRating);
  if (!Number.isFinite(rating)) return null;
  const votes = parseInt(String(raw.imdbVotes || "").replace(/[^\d]/g, ""), 10) || 0;
  const posterSrc = raw.Poster && raw.Poster !== "N/A" ? raw.Poster : null;
  const poster = proxyPoster(posterSrc, "SX600");
  const posterLarge = proxyPoster(posterSrc, "SX900");
  return {
    imdbID: raw.imdbID,
    title: raw.Title,
    year: raw.Year,
    rated: raw.Rated !== "N/A" ? raw.Rated : null,
    runtime: raw.Runtime !== "N/A" ? raw.Runtime : null,
    genre: raw.Genre !== "N/A" ? raw.Genre : null,
    director: raw.Director !== "N/A" ? raw.Director : null,
    actors: raw.Actors !== "N/A" ? raw.Actors : null,
    plot: raw.Plot !== "N/A" ? raw.Plot : null,
    language: raw.Language !== "N/A" ? raw.Language : null,
    country: raw.Country !== "N/A" ? raw.Country : null,
    awards: raw.Awards !== "N/A" ? raw.Awards : null,
    rating,
    votes,
    poster,
    posterLarge,
    type: raw.Type,
    imdbURL: `https://www.imdb.com/title/${raw.imdbID}/`,
  };
}

async function fetchByTitle(title, plan, apiKey) {
  const params = { t: title, plot: "full" };
  if (plan.media_type) params.type = plan.media_type;
  const raw = await fetchJSON(omdbURL(params, apiKey), {}, 8000);
  return normalizeMovie(raw);
}

async function fetchBySearch(keyword, plan, apiKey) {
  const params = { s: keyword };
  if (plan.media_type) params.type = plan.media_type;
  const data = await fetchJSON(omdbURL(params, apiKey), {}, 8000);
  const hits = Array.isArray(data?.Search) ? data.Search.slice(0, 6) : [];
  const details = await Promise.allSettled(
    hits.map((h) => fetchJSON(omdbURL({ i: h.imdbID, plot: "full" }, apiKey), {}, 8000))
  );
  return details
    .filter((d) => d.status === "fulfilled")
    .map((d) => normalizeMovie(d.value))
    .filter(Boolean);
}

// ---------- 3. 汇总 / 筛选 / 排序 ----------

function inYearRange(movie, plan) {
  const year = parseInt(String(movie.year).replace(/[^\d]/g, "").slice(0, 4), 10);
  if (!Number.isFinite(year)) return true;
  if (plan.year_from && year < plan.year_from) return false;
  if (plan.year_to && year > plan.year_to) return false;
  return true;
}

export async function recommend(query, env = process.env) {
  const omdbKey = env.OMDB_API_KEY;
  if (!omdbKey) throw new HttpError(500, "服务端未配置 OMDB_API_KEY");
  const deepseekKey = env.DEEPSEEK_API_KEY;

  const plan = await parseIntent(query, deepseekKey);

  const byId = new Map();
  const collect = (settled) => {
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      for (const movie of s.value) {
        if (!byId.has(movie.imdbID)) byId.set(movie.imdbID, movie);
      }
    }
  };

  // 先查 LLM 给出的具体片名（精准）；结果不足时才用关键词模糊搜索补充，
  // 避免关键词搜索带入题材不符的噪音结果。
  collect(
    await Promise.allSettled(
      plan.titles.map((t) => fetchByTitle(t, plan, omdbKey).then((m) => (m ? [m] : [])))
    )
  );
  if (byId.size < 8 && plan.keywords.length > 0) {
    collect(await Promise.allSettled(plan.keywords.map((k) => fetchBySearch(k, plan, omdbKey))));
  }
  let pool = [...byId.values()].filter((m) => inYearRange(m, plan));

  let minRating = plan.min_rating;
  let relaxed = false;
  let filtered = pool.filter((m) => m.rating >= minRating);
  if (filtered.length < MIN_RESULTS_BEFORE_RELAX && minRating > 5.5) {
    minRating = Math.max(5.5, +(minRating - 1).toFixed(1));
    const wider = pool.filter((m) => m.rating >= minRating);
    if (wider.length > filtered.length) {
      filtered = wider;
      relaxed = true;
    }
  }

  filtered.sort((a, b) => b.rating - a.rating || b.votes - a.votes);
  const movies = filtered.slice(0, RESULT_LIMIT);

  return {
    summary: plan.summary,
    minRating,
    relaxed,
    count: movies.length,
    movies,
  };
}

// ---------- HTTP 入口 ----------

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }
  try {
    const query = String(req.body?.query || "").trim();
    if (!query || query.length > 200) {
      throw new HttpError(400, "请输入 1 到 200 字的观影需求");
    }
    const result = await recommend(query);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message || "服务暂时不可用" });
  }
}
