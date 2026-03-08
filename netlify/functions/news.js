const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const USER_AGENT = "AI-News-Hub-Netlify/1.0";
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

function scoreItem(item, trackedKeywords) {
  let score = 0;

  const published = parseDate(item.published);
  if (published) {
    const ageMs = Date.now() - published.getTime();
    if (ageMs <= 6 * 3600 * 1000) score += 35;
    else if (ageMs <= 24 * 3600 * 1000) score += 25;
    else if (ageMs <= 72 * 3600 * 1000) score += 15;
  }

  const blob = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  let hits = 0;
  for (const kw of trackedKeywords) {
    if (blob.includes(kw)) hits += 1;
  }
  score += Math.min(hits * 5, 40);

  const sourceType = String(item.source_type || "").toLowerCase();
  if (sourceType === "official") score += 15;
  else if (sourceType === "company") score += 10;
  else if (sourceType === "outlet") score += 8;

  return score;
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

      let url = "";
      const links = asArray(entry.link);
      const preferred = links.find((lnk) => !lnk?.rel || lnk.rel === "alternate") || links[0];
      url = cleanText(getLink(preferred));

      const published = cleanText(getText(entry.published || entry.updated));
      return { title, summary, url, published, source: sourceName, source_type: sourceType };
    })
    .filter((item) => item.title && item.url);
}

function parseFeed(xml, sourceName, sourceType) {
  const root = XML.parse(xml);

  if (root?.rss?.channel) {
    return parseRss(root.rss, sourceName, sourceType);
  }

  if (root?.feed?.entry) {
    return parseAtom(root.feed, sourceName, sourceType);
  }

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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

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

async function collectNews(hours = 72, maxItems = 150) {
  const cfg = loadConfig();
  const feeds = asArray(cfg.feeds);
  const trackedKeywords = asArray(cfg.tracked_keywords).map((kw) => String(kw).toLowerCase());
  const cutoff = Date.now() - hours * 3600 * 1000;

  const results = await Promise.all(feeds.map((feed) => fetchFeed(feed)));

  const allItems = [];
  const errors = [];

  for (const result of results) {
    if (result.error) errors.push(result.error);
    allItems.push(...result.items);
  }

  const dedupe = new Map();

  for (const item of allItems) {
    const link = String(item.url || "").trim();
    if (!link) continue;

    const published = parseDate(item.published);
    if (published && published.getTime() < cutoff) continue;

    const key = link.toLowerCase().replace(/\/$/, "");
    item.score = scoreItem(item, trackedKeywords);

    const existing = dedupe.get(key);
    if (!existing || item.score > existing.score) {
      dedupe.set(key, item);
    }
  }

  const items = Array.from(dedupe.values())
    .sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (parseDate(b.published)?.getTime() || 0) - (parseDate(a.published)?.getTime() || 0);
    })
    .slice(0, maxItems);

  return {
    generated_at: new Date().toISOString(),
    tracked_keywords: cfg.tracked_keywords || [],
    count: items.length,
    items,
    errors,
  };
}

exports.handler = async (event) => {
  try {
    const hoursParam = Number.parseInt(event.queryStringParameters?.hours || "72", 10);
    const maxParam = Number.parseInt(event.queryStringParameters?.max || "150", 10);

    const hours = Number.isFinite(hoursParam) ? Math.max(1, Math.min(hoursParam, 24 * 14)) : 72;
    const maxItems = Number.isFinite(maxParam) ? Math.max(10, Math.min(maxParam, 400)) : 150;

    const payload = await collectNews(hours, maxItems);

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
