# News Intelligence Hub

Topic-driven news aggregation with lane-based discovery and quality controls.

## What You Get
- Editable topics in the UI.
- Two lanes:
  - `High Signal`: stricter relevance + higher score threshold.
  - `Discovery`: broader scope for early signals.
- Broader query intent coverage each refresh:
  - topic radar
  - launches/releases
  - funding/M&A
  - partnerships/integrations
  - enterprise deployments
  - policy/regulation
  - research/benchmarks
- Expanded source universe (official blogs + outlets + Google News + HN).

## Live Netlify Setup
1. Connect repo `ReveVersant/NewsCrawller` in Netlify.
2. Netlify reads [netlify.toml](./netlify.toml):
   - publish: `docs`
   - functions: `netlify/functions`
3. Deploy and open your Netlify URL.
4. Use topics + lane + quality controls and click `Refresh Feed`.

Route mapping:
- `/api/news` -> `/.netlify/functions/news`

## Local Live Mode
```powershell
py -3 server.py
```
Open [http://127.0.0.1:8080](http://127.0.0.1:8080)

## Optional Static Snapshot
```powershell
py -3 scripts/generate_static_news.py --lane discovery
```

## Config
Edit [config/sources.json](./config/sources.json):
- `default_topics`
- `search`
- `quality`
- `feeds`
