# OurShopee Price Monitor — Backend API

Express.js REST API that wraps the Playwright-based scraper and serves the Next.js frontend.

## Environment Variables

Create a `.env` file (see `.env.example`):

```
PORT=3001
ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:3000
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.8-flash
```

## Local Development

```bash
npm install
# Install Playwright browsers (once)
npx playwright install chromium
npm run dev
```

## Deploy to Railway

1. Create a new Railway project
2. Connect this `web/backend` folder (or the full repo with Railway config pointing here)
3. Add environment variables in Railway dashboard
4. Railway auto-detects Node.js and runs `npm start`

### Important: Playwright on Railway

Railway supports Playwright on its standard Node runtime. Add this to your Railway start command or `package.json` postinstall:

```bash
npx playwright install chromium --with-deps
```

Or add a `nixpacks.toml` at the backend root:

```toml
[phases.setup]
nixPkgs = ["chromium", "glib", "nss", "nspr", "at-spi2-atk", "cups", "dbus", "expat", "xorg.libX11"]

[phases.build]
cmds = ["npm install", "npx playwright install chromium"]

[start]
cmd = "node src/server.js"
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness probe |
| POST | `/api/jobs` | Start scrape job (multipart: `file`, `limit`, `headless`, `skus`, `exact`) |
| GET | `/api/jobs` | List recent jobs |
| GET | `/api/jobs/:id` | Poll job status + logs |
| GET | `/api/jobs/:id/result` | Download result CSV |
| GET | `/api/search?q=&site=&limit=` | Quick product search |
