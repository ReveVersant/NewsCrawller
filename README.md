# News Intelligence Hub

Topic-driven news scraping/aggregation with user-controlled quality filtering.

## What Changed
- Topics are editable in the UI (comma-separated).
- Quality scoring/filtering is user-controllable:
  - `Min quality score` slider
  - `Strict topic matching` toggle
- Dynamic topic search feed is generated each refresh (Google News RSS query from your topics).
- Noise reduction is built in via quality heuristics (domain weighting, noise-term penalties, dedupe).

## Live Netlify Setup
1. Connect repo `ReveVersant/NewsCrawller` in Netlify.
2. Netlify reads [netlify.toml](./netlify.toml):
   - publish: `docs`
   - functions: `netlify/functions`
3. Deploy and open your Netlify URL.
4. Use the controls at the top of the page to tune topics and quality.

Route mapping:
- `/api/news` -> `/.netlify/functions/news`

## Local Live Mode
```powershell
py -3 server.py
```
Open [http://127.0.0.1:8080](http://127.0.0.1:8080)

## Optional Static Snapshot
```powershell
py -3 scripts/generate_static_news.py --strict --min-score 60
```

## Config
Edit [config/sources.json](./config/sources.json):
- `default_topics`
- `search`
- `quality`
- `feeds`
