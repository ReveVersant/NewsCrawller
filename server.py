import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config" / "sources.json"
WEB_DIR = ROOT / "docs"

USER_AGENT = "AI-News-Hub/1.0 (+local dashboard)"
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


def score_item(item: dict, tracked_keywords: list[str]) -> int:
    score = 0
    now = datetime.now(UTC)
    published = parse_date(item.get("published"))

    if published:
        age = now - published
        if age <= timedelta(hours=6):
            score += 35
        elif age <= timedelta(hours=24):
            score += 25
        elif age <= timedelta(hours=72):
            score += 15

    blob = f"{item.get('title', '')} {item.get('summary', '')}".lower()
    hits = 0
    for kw in tracked_keywords:
        if kw in blob:
            hits += 1

    score += min(hits * 5, 40)

    source_type = (item.get("source_type") or "").lower()
    if source_type == "official":
        score += 15
    elif source_type == "company":
        score += 10
    elif source_type == "outlet":
        score += 8

    return score


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


def collect_news(hours: int = 72, max_items: int = 150) -> dict:
    cfg = load_config()
    feeds = cfg.get("feeds", [])
    tracked_keywords = [k.lower() for k in cfg.get("tracked_keywords", [])]

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

    dedupe: dict[str, dict] = {}
    for item in all_items:
        link = item.get("url", "").strip()
        if not link:
            continue

        published_dt = parse_date(item.get("published"))
        if published_dt and published_dt < cutoff:
            continue

        key = link.lower().rstrip("/")
        item["score"] = score_item(item, tracked_keywords)

        existing = dedupe.get(key)
        if existing is None or item["score"] > existing["score"]:
            dedupe[key] = item

    items = list(dedupe.values())
    items.sort(
        key=lambda x: (
            x.get("score", 0),
            parse_date(x.get("published")) or datetime(1970, 1, 1, tzinfo=UTC),
        ),
        reverse=True,
    )

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "tracked_keywords": cfg.get("tracked_keywords", []),
        "count": len(items[:max_items]),
        "items": items[:max_items],
        "errors": errors,
    }


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

            payload = collect_news(hours=hours, max_items=max_items)
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


