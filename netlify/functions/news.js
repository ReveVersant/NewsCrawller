const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const USER_AGENT = "AI-News-Hub-Netlify/2.0";
const REQUEST_TIMEOUT_MS = 12000;

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  cdataPropName: "__cdata",
  trimValues: true,
  processEntities: true,
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTopics(raw) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqueTerms(terms, maxTerms = 12) {
  const out = [];
  const seen = new Set();

  for (const term of asArray(terms)) {
    const cleaned = String(term).replace(/\s+/g, " ").trim();
    if (!cleaned) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(cleaned);

    if (out.length >= maxTerms) break;
  }

  return out;
}

function getText(value) {
  if (value == null) return "";

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    return value.map(getText).filter(Boolean).join(" ").trim();
  }

  if (typeof value === "object") {
    if (typeof value["#text"] === "string") return value["#text"].trim();
    if (typeof value.__cdata === "string") return value.__cdata.trim();
    return Object.values(value).map(getText).filter(Boolean).join(" ").trim();
  }

  return "";
}

function getLink(value) {
  if (value == null) return "";
  if (typeof value === "string") return cleanText(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = getLink(item);
      if (candidate) return candidate;
    }
    return "";
  }

  if (typeof value === "object") {
    if (typeof value.href === "string") return cleanText(value.href);
    if (typeof value.url === "string") return cleanText(value.url);
    if (typeof value["#text"] === "string") return cleanText(value["#text"]);
  }

  return cleanText(getText(value));
}

function parseDate(raw) {
  if (!raw) return null;
  const ts = Date.parse(String(raw).trim());
  if (Number.isNaN(ts)) return null;
  return new Date(ts);
}

function domainOf(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function domainMatch(domain, allowed) {
  return asArray(allowed).some((base) => domain === base || domain.endsWith(`.${base}`));
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countTopicHits(title, summary, topics) {
  const titleHits = topics.filter((kw) => kw && title.includes(kw)).length;
  const summaryHits = topics.filter((kw) => kw && summary.includes(kw)).length;
  return { titleHits, summaryHits };
}

function qualitySettings(cfg) {
  const quality = cfg.quality || {};
  return {
    default_min_score: Number.parseInt(quality.default_min_score || 30, 10),
    strict_min_score: Number.parseInt(quality.strict_min_score || 45, 10),
    noise_terms: asArray(quality.noise_terms || [
      "sponsored",
      "coupon",
      "discount",
      "giveaway",
      "promo",
      "rumor",
      "roundup",
      "listicle",
      "op-ed",
    ]).map((x) => String(x).toLowerCase()),
    high_value_domains: asArray(quality.high_value_domains || [
      "openai.com",
      "anthropic.com",
      "googleblog.com",
      "deepmind.google",
      "microsoft.com",
      "aws.amazon.com",
      "venturebeat.com",
      "techcrunch.com",
      "reuters.com",
      "ft.com",
      "wsj.com",
      "bloomberg.com",
    ]).map((x) => String(x).toLowerCase()),
    low_value_domains: asArray(quality.low_value_domains || ["youtube.com", "youtu.be", "tiktok.com"]).map((x) => String(x).toLowerCase()),
  };
}

function defaultTopics(cfg) {
  return uniqueTerms(cfg.default_topics || cfg.tracked_keywords || []);
}

function buildGoogleNewsUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function buildDynamicFeeds(cfg, topics) {
  const searchCfg = cfg.search || {};
  if (searchCfg.enabled === false) return [];

  const maxTopics = Number.parseInt(searchCfg.max_topics || 8, 10);
  const chosen = topics.slice(0, Math.max(1, maxTopics));
  if (chosen.length === 0) return [];

  const orClause = chosen.join(" OR ");
  const q1 = `(${orClause})`;
  const q2 = `(${orClause}) (acquisition OR partnership OR launch OR enterprise OR funding OR release OR integration)`;

  return [
    { name: "Google News - Topic Search", url: buildGoogleNewsUrl(q1), type: "news" },
    { name: "Google News - High-Impact Events", url: buildGoogleNewsUrl(q2), type: "news" },
  ];
}

function scoreItem(item, titleHits, summaryHits, quality) {
  let score = 0;

  const title = String(item.title || "").toLowerCase();
  const summary = String(item.summary || "").toLowerCase();
  const blob = `${title} ${summary}`;

  const published = parseDate(item.published);
  if (published) {
    const ageMs = Date.now() - published.getTime();
    if (ageMs <= 6 * 3600 * 1000) score += 28;
    else if (ageMs <= 24 * 3600 * 1000) score += 20;
    else if (ageMs <= 72 * 3600 * 1000) score += 12;
    else if (ageMs <= 168 * 3600 * 1000) score += 6;
  }

  score += Math.min(titleHits * 18, 54);
  score += Math.min(summaryHits * 7, 28);

  if (titleHits + summaryHits === 0) score -= 10;

  const sourceType = String(item.source_type || "").toLowerCase();
  if (sourceType === "official") score += 16;
  else if (sourceType === "company") score += 12;
  else if (sourceType === "outlet") score += 10;
  else if (sourceType === "community") score += 4;

  const domain = domainOf(item.url || "");
  if (domainMatch(domain, quality.high_value_domains)) score += 14;
  if (domainMatch(domain, quality.low_value_domains)) score -= 18;

  const noiseHits = quality.noise_terms.filter((term) => blob.includes(term)).length;
  score -= Math.min(noiseHits * 10, 30);

  if (["acquisition", "partnership", "funding", "launch", "release", "integration"].some((x) => blob.includes(x))) {
    score += 8;
  }

  if (String(item.title || "").length < 40) score -= 4;

  return Math.trunc(score);
}

function parseRss(rssRoot, sourceName, sourceType) {
  const channel = rssRoot?.channel;
  const entries = asArray(channel?.item);

  return entries
    .map((entry) => {
      const title = cleanText(getText(entry.title));
      const summary = cleanText(getText(entry.description || entry.content || entry.summary));
      const url = cleanText(getLink(entry.link));
      const published = cleanText(getText(entry.pubDate || entry.published || entry.updated));

      return { title, summary, url, published, source: sourceName, source_type: sourceType };
    })
    .filter((item) => item.title && item.url);
}

function parseAtom(feedRoot, sourceName, sourceType) {
  const entries = asArray(feedRoot?.entry);

  return entries
    .map((entry) => {
      const title = cleanText(getText(entry.title));
      const summary = cleanText(getText(entry.summary || entry.content));

      const links = asArray(entry.link);
      const preferred = links.find((lnk) => !lnk?.rel || lnk.rel === "alternate") || links[0];
      const url = cleanText(getLink(preferred));

      const published = cleanText(getText(entry.published || entry.updated));
      return { title, summary, url, published, source: sourceName, source_type: sourceType };
    })
    .filter((item) => item.title && item.url);
}

function parseFeed(xml, sourceName, sourceType) {
  const root = XML.parse(xml);

  if (root?.rss?.channel) return parseRss(root.rss, sourceName, sourceType);
  if (root?.feed?.entry) return parseAtom(root.feed, sourceName, sourceType);

  return [];
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(feed.url, {
      headers: { "user-agent": USER_AGENT },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.text();
    const items = parseFeed(payload, feed.name, feed.type || "outlet");
    return { items, error: null };
  } catch (error) {
    return { items: [], error: `${feed.name}: ${error.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

function loadConfig() {
  const configPath = path.resolve(__dirname, "../../config/sources.json");
  const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function parseBool(raw) {
  return ["1", "true", "yes", "on", "high", "strict"].includes(String(raw || "").toLowerCase());
}

async function collectNews({ hours = 72, maxItems = 150, topics = null, minScore = null, strict = false } = {}) {
  const cfg = loadConfig();
  const quality = qualitySettings(cfg);

  const topicsUsed = uniqueTerms((topics && topics.length ? topics : defaultTopics(cfg)));
  const topicTerms = topicsUsed.map((x) => x.toLowerCase());

  let appliedMinScore = minScore;
  if (appliedMinScore == null || Number.isNaN(Number(appliedMinScore))) {
    appliedMinScore = strict ? quality.strict_min_score : quality.default_min_score;
  }
  appliedMinScore = Math.max(0, Math.min(100, Number.parseInt(appliedMinScore, 10)));

  const feeds = asArray(cfg.feeds).concat(buildDynamicFeeds(cfg, topicsUsed));
  const cutoff = Date.now() - hours * 3600 * 1000;

  const results = await Promise.all(feeds.map((feed) => fetchFeed(feed)));

  const allItems = [];
  const errors = [];
  for (const result of results) {
    if (result.error) errors.push(result.error);
    allItems.push(...result.items);
  }

  const byLink = new Map();

  for (const item of allItems) {
    const link = String(item.url || "").trim();
    if (!link) continue;

    const published = parseDate(item.published);
    if (published && published.getTime() < cutoff) continue;

    const titleLower = String(item.title || "").toLowerCase();
    const summaryLower = String(item.summary || "").toLowerCase();
    const { titleHits, summaryHits } = countTopicHits(titleLower, summaryLower, topicTerms);

    if (strict && titleHits + summaryHits === 0) continue;

    const score = scoreItem(item, titleHits, summaryHits, quality);
    if (score < appliedMinScore) continue;

    const domain = domainOf(link);
    const enriched = { ...item, score, domain, topic_hits: titleHits + summaryHits };

    const key = link.toLowerCase().replace(/\/$/, "");
    const existing = byLink.get(key);
    if (!existing || enriched.score > existing.score) {
      byLink.set(key, enriched);
    }
  }

  const ranked = Array.from(byLink.values()).sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (parseDate(b.published)?.getTime() || 0) - (parseDate(a.published)?.getTime() || 0);
  });

  const final = [];
  const seenTitles = new Set();

  for (const item of ranked) {
    const key = normalizeTitle(item.title || "");
    if (key && seenTitles.has(key)) continue;
    if (key) seenTitles.add(key);
    final.push(item);
    if (final.length >= maxItems) break;
  }

  return {
    generated_at: new Date().toISOString(),
    topics_used: topicsUsed,
    tracked_keywords: topicsUsed,
    min_score_applied: appliedMinScore,
    strict_mode: strict,
    count: final.length,
    items: final,
    errors,
  };
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};

    const hoursParam = Number.parseInt(qs.hours || "72", 10);
    const maxParam = Number.parseInt(qs.max || "150", 10);
    const minScoreParam = qs.min_score == null || qs.min_score === "" ? null : Number.parseInt(qs.min_score, 10);

    const hours = Number.isFinite(hoursParam) ? Math.max(1, Math.min(hoursParam, 24 * 14)) : 72;
    const maxItems = Number.isFinite(maxParam) ? Math.max(10, Math.min(maxParam, 400)) : 150;

    const strict = parseBool(qs.strict);
    const topics = uniqueTerms(splitTopics(qs.topics || ""));

    const payload = await collectNews({
      hours,
      maxItems,
      topics: topics.length ? topics : null,
      minScore: Number.isFinite(minScoreParam) ? minScoreParam : null,
      strict,
    });

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=120",
      },
      body: JSON.stringify(payload),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        error: "Failed to collect news",
        message: error.message,
      }),
    };
  }
};
