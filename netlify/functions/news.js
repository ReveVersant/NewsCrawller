const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const USER_AGENT = "AI-News-Hub-Netlify/2.1";
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
    high_signal_min_score: Number.parseInt(quality.high_signal_min_score || 45, 10),
    high_signal_strict: quality.high_signal_strict !== false,
    discovery_min_score: Number.parseInt(quality.discovery_min_score || 18, 10),
    discovery_strict: quality.discovery_strict === true,
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

function laneDefaults(quality, lane) {
  const laneName = String(lane || "high_signal").toLowerCase();
  if (laneName === "discovery") {
    return {
      laneName,
      minScore: quality.discovery_min_score,
      strict: quality.discovery_strict,
    };
  }
  return {
    laneName: "high_signal",
    minScore: quality.high_signal_min_score,
    strict: quality.high_signal_strict,
  };
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

  const queryTerms = chosen.map((t) => (t.includes(" ") ? `"${t}"` : t));
  const orClause = queryTerms.join(" OR ");

  const intents = [
    ["Google News - Topic Radar", `(${orClause})`],
    ["Google News - Launches and Releases", `(${orClause}) (launch OR release OR roadmap OR unveiled OR announced OR preview)`],
    ["Google News - Funding and M&A", `(${orClause}) (funding OR investment OR acquisition OR merger OR buyout)`],
    ["Google News - Partnerships and Integrations", `(${orClause}) (partnership OR integration OR alliance OR collaboration)`],
    ["Google News - Enterprise Deployments", `(${orClause}) (enterprise OR deployment OR adoption OR contact center OR customer support)`],
    ["Google News - Policy and Regulation", `(${orClause}) (regulation OR policy OR compliance OR privacy OR safety)`],
    ["Google News - Research and Benchmarks", `(${orClause}) (benchmark OR paper OR evaluation OR model OR multimodal)`],
  ];

  const feeds = intents.map(([name, query]) => ({
    name,
    url: buildGoogleNewsUrl(query),
    type: "news",
  }));

  const hnQuery = chosen.slice(0, 4).join(" OR ");
  feeds.push({
    name: "HN RSS - Dynamic Topics",
    url: `https://hnrss.org/newest?q=${encodeURIComponent(hnQuery)}`,
    type: "community",
  });

  return feeds;
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

  if (titleHits + summaryHits === 0) score -= 25;

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

const FALLBACK_CONFIG = {
  default_topics: ["conversational ai", "chatbots", "voice bots", "digital automation", "contact center ai"],
  search: { enabled: true, max_topics: 8 },
  quality: {
    default_min_score: 30,
    strict_min_score: 45,
    high_signal_min_score: 45,
    high_signal_strict: true,
    discovery_min_score: 18,
    discovery_strict: false,
    noise_terms: ["sponsored", "coupon", "discount", "giveaway", "promo", "rumor", "roundup", "listicle", "op-ed"],
    high_value_domains: ["openai.com", "anthropic.com", "googleblog.com", "deepmind.google", "microsoft.com", "aws.amazon.com", "venturebeat.com", "techcrunch.com", "reuters.com", "ft.com", "wsj.com", "bloomberg.com"],
    low_value_domains: ["youtube.com", "youtu.be", "tiktok.com"],
  },
  feeds: [
    { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/", type: "outlet" },
    { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", type: "outlet" },
    { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", type: "outlet" },
    { name: "InfoQ AI/ML", url: "https://www.infoq.com/ai-ml-data-eng/feed/", type: "outlet" },
    { name: "OpenAI News", url: "https://openai.com/news/rss.xml", type: "official" },
    { name: "Google DeepMind Blog", url: "https://deepmind.google/blog/rss.xml", type: "official" },
    { name: "Microsoft AI Blog", url: "https://blogs.microsoft.com/ai/feed/", type: "official" },
    { name: "AWS Machine Learning Blog", url: "https://aws.amazon.com/blogs/machine-learning/feed/", type: "official" },
    { name: "NVIDIA Blog", url: "https://blogs.nvidia.com/feed/", type: "official" },
    { name: "Google Cloud AI/ML Blog", url: "https://cloud.google.com/blog/products/ai-machine-learning/rss/", type: "official" },
    { name: "Google News - AI Industry Radar", url: "https://news.google.com/rss/search?q=%28artificial+intelligence+OR+enterprise+ai+OR+ai+automation%29&hl=en-US&gl=US&ceid=US:en", type: "news" },
    { name: "Google News - Enterprise Automation", url: "https://news.google.com/rss/search?q=%28enterprise+automation+OR+contact+center+automation+OR+customer+service+ai%29&hl=en-US&gl=US&ceid=US:en", type: "news" },
    { name: "Google News - Voice and Speech AI", url: "https://news.google.com/rss/search?q=%28voice+ai+OR+speech+ai+OR+voicebot+OR+text-to-speech%29&hl=en-US&gl=US&ceid=US:en", type: "news" },
    { name: "HN RSS - AI", url: "https://hnrss.org/newest?q=%22artificial+intelligence%22+OR+chatbot+OR+automation", type: "community" },
  ],
};

function loadConfig() {
  const candidates = [
    path.resolve(process.cwd(), "config/sources.json"),
    path.resolve(__dirname, "config/sources.json"),
    path.resolve(__dirname, "../config/sources.json"),
    path.resolve(__dirname, "../../config/sources.json"),
  ];

  for (const configPath of candidates) {
    if (!fs.existsSync(configPath)) continue;
    const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  }

  return FALLBACK_CONFIG;
}

function parseBool(raw) {
  return ["1", "true", "yes", "on", "high", "strict"].includes(String(raw || "").toLowerCase());
}

async function collectNews({ hours = 72, maxItems = 150, topics = null, minScore = null, strict = null, lane = "high_signal" } = {}) {
  const cfg = loadConfig();
  const quality = qualitySettings(cfg);

  const laneDefaultsValue = laneDefaults(quality, lane);
  const laneApplied = laneDefaultsValue.laneName;

  const topicsUsed = uniqueTerms((topics && topics.length ? topics : defaultTopics(cfg)));
  const topicTerms = topicsUsed.map((x) => x.toLowerCase());

  let appliedMinScore = minScore;
  if (appliedMinScore == null || Number.isNaN(Number(appliedMinScore))) {
    appliedMinScore = laneDefaultsValue.minScore;
  }
  appliedMinScore = Math.max(0, Math.min(100, Number.parseInt(appliedMinScore, 10)));

  let appliedStrict = strict;
  if (appliedStrict == null) {
    appliedStrict = laneDefaultsValue.strict;
  }

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

    if (appliedStrict && titleHits + summaryHits === 0) continue;

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
    lane_applied: laneApplied,
    min_score_applied: appliedMinScore,
    strict_mode: !!appliedStrict,
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

    const strictRaw = qs.strict;
    const strict = strictRaw == null || strictRaw === "" ? null : parseBool(strictRaw);
    const topics = uniqueTerms(splitTopics(qs.topics || ""));
    const laneRaw = String(qs.lane || "high_signal").toLowerCase();
    const lane = laneRaw === "discovery" ? "discovery" : "high_signal";

    const payload = await collectNews({
      hours,
      maxItems,
      topics: topics.length ? topics : null,
      minScore: Number.isFinite(minScoreParam) ? minScoreParam : null,
      strict,
      lane,
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
