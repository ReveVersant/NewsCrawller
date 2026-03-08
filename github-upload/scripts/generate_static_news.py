import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import collect_news  # noqa: E402


def resolve_outputs(explicit: list[str] | None) -> list[Path]:
    if explicit:
        return [Path(p).resolve() for p in explicit]

    targets = [ROOT / "web" / "news.json"]
    docs_target = ROOT / "docs" / "news.json"
    if (ROOT / "docs").exists():
        targets.append(docs_target)
    return targets


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a static news snapshot for manual static hosting."
    )
    parser.add_argument("--hours", type=int, default=24 * 14, help="Lookback window in hours.")
    parser.add_argument("--max", dest="max_items", type=int, default=400, help="Max stories.")
    parser.add_argument(
        "--output",
        action="append",
        help="Output JSON path. Provide more than once for multiple targets.",
    )
    args = parser.parse_args()

    payload = collect_news(hours=args.hours, max_items=args.max_items)

    outputs = resolve_outputs(args.output)
    for output in outputs:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote {payload['count']} items to {output}")

    if payload.get("errors"):
        print(f"Feed warnings: {len(payload['errors'])}")


if __name__ == "__main__":
    main()
