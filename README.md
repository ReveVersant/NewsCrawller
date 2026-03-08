# Conversational AI News Hub

A news hub for early updates on conversational AI, chatbots, voice bots, and digital automation.

## Folders
- `web/`: app files for local server mode.
- `docs/`: static publish folder for GitHub Pages.
- `config/sources.json`: tracked keywords + feed list.
- `scripts/generate_static_news.py`: manual snapshot generator.
- `server.py`: local live API server (`/api/news`).

## Check It Locally Right Now
```powershell
py -3 server.py
```
Open [http://127.0.0.1:8080](http://127.0.0.1:8080)

## Manual GitHub Pages Publish (No Auto-Publish)
1. Refresh the static snapshot:
   ```powershell
   py -3 scripts/generate_static_news.py
   ```
   This updates both:
   - `web/news.json`
   - `docs/news.json`

2. Upload/push this repo to GitHub.
3. In GitHub: `Settings -> Pages`.
4. Set source to:
   - `Deploy from a branch`
   - Branch: your main branch
   - Folder: `/docs`
5. Save and wait for GitHub Pages URL.

## Updating News Later
Run:
```powershell
py -3 scripts/generate_static_news.py
```
Then commit/push updated `docs/news.json`.

## Customize Sources
Edit `config/sources.json`:
- `tracked_keywords`: relevance terms.
- `feeds`: RSS/Atom feeds.
