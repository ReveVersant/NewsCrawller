import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config" / "sources.json"
WEB_DIR = ROOT / "docs"

USER_AGENT = "AI-News-Hub/2.0 (+local dashboard)"
REQUEST_TIMEOUT_SECONDS = 12
MAX_WORKERS = 8


def load_config() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def text_of(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return " ".join(el.itertext()).strip()


def first(el: ET.Element, names: list[str]) -> ET.Element | None:
    for name in names:
        node = el.find(name)
        if node is not None:
            return node
    return None


def parse_date(raw: str | None) -> datetime | None:
    if not raw:
        return None

    raw = raw.strip()

    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC)
    except Exception:
        pass

    for fmt in (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d %H:%M:%S",
    ):
        try:
            dt = datetime.strptime(raw, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.astimezone(UTC)
        except ValueError:
            continue

    return None


def clean_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def split_topics(raw: str) -> list[str]:
    return [p.strip() for p in re.split(r"[,\n]+", raw) if p.strip()]


def unique_terms(terms: list[str], max_terms: int = 12) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for term in terms:
        cleaned = re.sub(r"\s+", " ", term).strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= max_terms:
            break
    return out


def default_topics(cfg: dict) -> list[str]:
    topics = cfg.get("default_topics") or cfg.get("tracked_keywords") or []
    return unique_terms([str(t) for t in topics])


def quality_settings(cfg: dict) -> dict:
    quality = cfg.get("quality", {})
    return {
        "default_min_score": int(quality.get("default_min_score", 30)),
        "strict_min_score": int(quality.get("strict_min_score", 45)),
        "noise_terms": [
            str(x).lower()
            for x in quality.get(
                "noise_terms",
                [
                    "sponsored",
                    "coupon",
                    "discount",
                    "giveaway",
                    "promo",
                    "rumor",
                    "roundup",
                    "listicle",
                    "op-ed",
                ],
            )
        ],
        "high_value_domains": [
            str(x).lower()
            for x in quality.get(
                "high_value_domains",
                [
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
                ],
            )
        ],
        "low_value_domains": [
            str(x).lower()
            for x in quality.get("low_value_domains", ["youtube.com", "youtu.be", "tiktok.com"])
        ],
    }


def build_dynamic_feeds(cfg: dict, topics: list[str]) -> list[dict]:
    search_cfg = cfg.get("search", {})
    if not search_cfg.get("enabled", True):
        return []

    max_topics = int(search_cfg.get("max_topics", 8))
    chosen = topics[: max(1, max_topics)]
    if not chosen:
        return []

    or_clause = " OR ".join(chosen)

    q1 = f"({or_clause})"
    q2 = (
        f"({or_clause}) "
        "(acquisition OR partnership OR launch OR enterprise OR funding OR release OR integration)"
    )

    return [
        {
            "name": "Google News - Topic Search",
            "url": f"https://news.google.com/rss/search?q={quote_plus(q1)}&hl=en-US&gl=US&ceid=US:en",
            "type": "news",
        },
        {
            "name": "Google News - High-Impact Events",
            "url": f"https://news.google.com/rss/search?q={quote_plus(q2)}&hl=en-US&gl=US&ceid=US:en",
            "type": "news",
        },
    ]


def domain_of(url: str) -> str:
    domain = urlparse(url).netloc.lower().strip()
    if domain.startswith("www."):
        domain = domain[4:]
    return domain


def domain_match(domain: str, allowed: list[str]) -> bool:
    for base in allowed:
        if domain == base or domain.endswith("." + base):
            return True
    return False


def normalize_title(value: str) -> str:
    value = re.sub(r"[^a-z0-9\s]", " ", value.lower())
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def count_topic_hits(title: str, summary: str, topics: list[str]) -> tuple[int, int]:
    title_hits = sum(1 for kw in topics if kw and kw in title)
    summary_hits = sum(1 for kw in topics if kw and kw in summary)
    return title_hits, summary_hits


def score_item(item: dict, title_hits: int, summary_hits: int, quality: dict) -> int:
    score = 0
    now = datetime.now(UTC)

    title = (item.get("title") or "").lower()
    summary = (item.get("summary") or "").lower()
    blob = f"{title} {summary}"

    published = parse_date(item.get("published"))
    if published:
        age = now - published
        if age <= timedelta(hours=6):
            score += 28
        elif age <= timedelta(hours=24):
            score += 20
        elif age <= timedelta(hours=72):
            score += 12
        elif age <= timedelta(hours=168):
            score += 6

    score += min(title_hits * 18, 54)
    score += min(summary_hits * 7, 28)

    if title_hits + summary_hits == 0:
        score -= 10

    source_type = (item.get("source_type") or "").lower()
    if source_type == "official":
        score += 16
    elif source_type == "company":
        score += 12
    elif source_type == "outlet":
        score += 10
    elif source_type == "community":
        score += 4

    domain = domain_of(item.get("url", ""))
    if domain_match(domain, quality["high_value_domains"]):
        score += 14
    if domain_match(domain, quality["low_value_domains"]):
        score -= 18

    noise_hits = sum(1 for term in quality["noise_terms"] if term in blob)
    score -= min(noise_hits * 10, 30)

    if any(x in blob for x in ["acquisition", "partnership", "funding", "launch", "release", "integration"]):
        score += 8

    if len(item.get("title", "")) < 40:
        score -= 4

    return int(score)


def parse_feed(xml_bytes: bytes, source_name: str, source_type: str) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    items: list[dict] = []

    channel = root.find("channel")
    if channel is not None:
        entries = channel.findall("item")
        for entry in entries:
            title = clean_text(text_of(first(entry, ["title"])))
            summary = clean_text(text_of(first(entry, ["description", "content", "summary"])))
            link = clean_text(text_of(first(entry, ["link"])))
            published = clean_text(text_of(first(entry, ["pubDate", "published", "updated"])))
            if not title or not link:
                continue
            items.append(
                {
                    "title": title,
                    "summary": summary,
                    "url": link,
                    "published": published,
                    "source": source_name,
                    "source_type": source_type,
                }
            )
        return items

    entries = root.findall("{http://www.w3.org/2005/Atom}entry")
    if not entries:
        entries = root.findall("entry")

    for entry in entries:
        title = clean_text(
            text_of(first(entry, ["{http://www.w3.org/2005/Atom}title", "title"]))
        )
        summary = clean_text(
            text_of(
                first(
                    entry,
                    [
                        "{http://www.w3.org/2005/Atom}summary",
                        "{http://www.w3.org/2005/Atom}content",
                        "summary",
                        "content",
                    ],
                )
            )
        )

        link_node = first(entry, ["{http://www.w3.org/2005/Atom}link", "link"])
        link = ""
        if link_node is not None:
            link = link_node.attrib.get("href") or clean_text(text_of(link_node))

        published = clean_text(
            text_of(
                first(
                    entry,
                    [
                        "{http://www.w3.org/2005/Atom}published",
                        "{http://www.w3.org/2005/Atom}updated",
                        "published",
                        "updated",
                    ],
                )
            )
        )

        if not title or not link:
            continue

        items.append(
            {
                "title": title,
                "summary": summary,
                "url": link,
                "published": published,
                "source": source_name,
                "source_type": source_type,
            }
        )

    return items


def fetch_feed(feed: dict) -> tuple[list[dict], str | None]:
    request = Request(feed["url"], headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            payload = response.read()
        parsed = parse_feed(payload, feed["name"], feed.get("type", "outlet"))
        return parsed, None
    except Exception as ex:
        return [], f"{feed['name']}: {ex}"


def collect_news(
    hours: int = 72,
    max_items: int = 150,
    topics: list[str] | None = None,
    min_score: int | None = None,
    strict: bool = False,
) -> dict:
    cfg = load_config()
    quality = quality_settings(cfg)

    topics_used = unique_terms(topics or default_topics(cfg))
    topic_terms = [x.lower() for x in topics_used]

    if min_score is None:
        min_score = quality["strict_min_score"] if strict else quality["default_min_score"]
    min_score = max(0, min(int(min_score), 100))

    feeds = list(cfg.get("feeds", []))
    feeds.extend(build_dynamic_feeds(cfg, topics_used))

    all_items: list[dict] = []
    errors: list[str] = []
    cutoff = datetime.now(UTC) - timedelta(hours=hours)

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, max(len(feeds), 1))) as pool:
        jobs = [pool.submit(fetch_feed, feed) for feed in feeds]
        for job in as_completed(jobs):
            items, err = job.result()
            if err:
                errors.append(err)
            all_items.extend(items)

    by_link: dict[str, dict] = {}

    for item in all_items:
        link = item.get("url", "").strip()
        if not link:
            continue

        published_dt = parse_date(item.get("published"))
        if published_dt and published_dt < cutoff:
            continue

        title_lower = (item.get("title") or "").lower()
        summary_lower = (item.get("summary") or "").lower()
        title_hits, summary_hits = count_topic_hits(title_lower, summary_lower, topic_terms)

        if strict and (title_hits + summary_hits == 0):
            continue

        score = score_item(item, title_hits, summary_hits, quality)
        if score < min_score:
            continue

        item["score"] = score
        item["domain"] = domain_of(link)
        item["topic_hits"] = title_hits + summary_hits
        key = link.lower().rstrip("/")

        existing = by_link.get(key)
        if existing is None or score > existing["score"]:
            by_link[key] = item

    ranked = list(by_link.values())
    ranked.sort(
        key=lambda x: (
            x.get("score", 0),
            parse_date(x.get("published")) or datetime(1970, 1, 1, tzinfo=UTC),
        ),
        reverse=True,
    )

    final: list[dict] = []
    seen_titles: set[str] = set()
    for item in ranked:
        key = normalize_title(item.get("title", ""))
        if key and key in seen_titles:
            continue
        if key:
            seen_titles.add(key)
        final.append(item)
        if len(final) >= max_items:
            break

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "topics_used": topics_used,
        "tracked_keywords": topics_used,
        "min_score_applied": min_score,
        "strict_mode": strict,
        "count": len(final),
        "items": final,
        "errors": errors,
    }


def parse_bool(raw: str | None) -> bool:
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on", "high", "strict"}


class HubHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/news":
            query = parse_qs(parsed.query)
            try:
                hours = int(query.get("hours", ["72"])[0])
                hours = max(1, min(hours, 24 * 14))
            except ValueError:
                hours = 72

            try:
                max_items = int(query.get("max", ["150"])[0])
                max_items = max(10, min(max_items, 400))
            except ValueError:
                max_items = 150

            min_score_raw = query.get("min_score", [None])[0]
            min_score = None
            if min_score_raw not in (None, ""):
                try:
                    min_score = int(min_score_raw)
                except ValueError:
                    min_score = None

            strict = parse_bool(query.get("strict", ["false"])[0])
            topics_raw = query.get("topics", [""])[0]
            topics = unique_terms(split_topics(topics_raw))

            payload = collect_news(
                hours=hours,
                max_items=max_items,
                topics=topics or None,
                min_score=min_score,
                strict=strict,
            )
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        return super().do_GET()


def main() -> None:
    host = "127.0.0.1"
    port = 8080
    server = ThreadingHTTPServer((host, port), HubHandler)
    print(f"AI News Hub running at http://{host}:{port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")


if __name__ == "__main__":
    main()
