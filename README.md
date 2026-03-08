# Conversational AI News Hub

A news hub for early updates on conversational AI, chatbots, voice bots, and digital automation.

## Live Hosting Options
- Local live API: `py -3 server.py`
- Netlify live API: serverless function at `/api/news` (fresh feed pulls on each refresh)
- Static fallback: `docs/news.json` and `web/news.json`

## Netlify (Non-Static) Setup
This repo is already configured for live Netlify fetching.

1. Connect repo `ReveVersant/NewsCrawller` in Netlify.
2. Site settings should resolve from `netlify.toml` automatically:
   - Publish directory: `docs`
   - Functions directory: `netlify/functions`
3. Deploy the site.
4. Open your Netlify URL and click `Refresh Feed`.

Netlify route mapping:
- `/api/news` -> `/.netlify/functions/news`

## Local Live Mode
```powershell
py -3 server.py
```
Open [http://127.0.0.1:8080](http://127.0.0.1:8080)

## Manual Static Snapshot Refresh (Optional)
If you want a backup snapshot:
```powershell
py -3 scripts/generate_static_news.py
```

## Customize Sources
Edit `config/sources.json`:
- `tracked_keywords`: relevance terms.
- `feeds`: RSS/Atom feeds.
