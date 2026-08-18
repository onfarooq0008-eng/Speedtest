# SwiftSpeed Test

A complete, self-hosted internet speed test website: real ping/jitter/download/upload
testing, a responsive mobile+desktop UI, SEO metadata, ad-slot management, and an
admin panel — ready to deploy on Koyeb.

## Features

- **Real speed test engine** — ping, jitter, download and upload, measured live in the browser (no third-party widget).
- **Responsive design** — one layout that adapts automatically to mobile and desktop (no separate site/redirect needed).
- **SEO built in** — meta title/description/keywords (pre-filled with high-volume speed-test search terms), Open Graph tags, JSON-LD structured data, `robots.txt`, `sitemap.xml`.
- **Ad management** — turn ads on/off and paste your AdSense/ad-network code into 4 slots (header, between-results, sidebar, footer) directly from the admin panel — no code edits or redeploys needed.
- **Admin panel** (`/admin`) — password-protected:
  - Dashboard with aggregate stats (avg download/upload/ping, mobile vs desktop split)
  - Full test-results log with pagination, and a "clear all" action
  - Site settings, SEO fields, ad codes, maintenance-mode toggle
  - Change admin password
- **No external database required** — uses a small JSON file store, so there's nothing extra to provision.
- **Site visit tracking** — every page view is logged (page, IP, referrer, device) and rolled up into a dashboard: total lifetime views, today's views, unique visitors today, a 7-day trend, and a top-pages breakdown, plus a full paginated visit log at `/admin/visits`.
- **AdSense-ready content pages** — About Us, Contact Us (with a working form that logs submissions to `/admin/messages`), Privacy Policy, Terms of Service, Disclaimer, and Cookie Policy — all linked from the site footer, indexed in `sitemap.xml`, and written with real, original content (not lorem-ipsum placeholders), which is what AdSense reviewers look for.

## Running locally

```bash
npm install
cp .env.example .env      # edit ADMIN_PASSWORD etc.
npm start
```

Visit `http://localhost:8000`. Admin panel: `http://localhost:8000/admin`.

On first run, a default admin account is created from your `.env` values
(`ADMIN_USER` / `ADMIN_PASSWORD`, default `admin` / `ChangeMe123!` if unset) —
**log in and change the password immediately** from Admin → Settings.

## Deploying to Koyeb

1. Push this project to a GitHub repo (or use Koyeb's "Deploy from Docker" flow).
2. In Koyeb, create a new **Web Service**:
   - Source: your GitHub repo, or select "Dockerfile" as the build method (a `Dockerfile` is included).
   - Port: `8000` (matches `EXPOSE 8000` / the app's default `PORT`).
3. Set environment variables in the Koyeb dashboard:
   - `SESSION_SECRET` — any long random string
   - `ADMIN_USER` — your admin username
   - `ADMIN_PASSWORD` — your admin password
4. Deploy. Koyeb will build the Docker image and run `node server.js` automatically.
5. **Important — persistent storage:** this app stores settings and test results
   in `/app/data/*.json` inside the container. Koyeb's default filesystem is
   ephemeral, so that data resets on every redeploy/restart. For production use,
   attach a Koyeb **Volume** mounted at `/app/data`, or swap the storage layer
   in `lib/db.js` for a managed database once you outgrow the JSON store.

## Enabling ads

1. Sign up for Google AdSense (or any ad network that gives you an HTML/JS snippet).
2. In `/admin/settings`, turn on **Enable Ads Site-Wide**, add your AdSense Client ID,
   and paste your ad unit code into whichever slots you want to use
   (header, between-results, sidebar, footer).
3. Save — ads appear on the live site immediately, no redeploy needed.

## Project structure

```
server.js            Express app + all routes (public + API + admin)
lib/db.js             Tiny JSON file-based data layer (settings/results/admin)
views/                EJS templates (public site, admin panel)
public/               Static assets — CSS, client-side speed test JS, robots.txt, sitemap.xml
data/                 Runtime JSON storage (auto-created on first boot)
Dockerfile            Container build for Koyeb
.env.example          Environment variable template
```

## Customizing the SEO keywords

Default keywords cover common high-search-volume terms (internet speed test, wifi
speed test, broadband speed test, mbps test, ping test, 5G speed test, etc.) and can
be edited anytime from Admin → Settings without touching code.

## Security notes

- Change the default admin password immediately after first deploy.
- Set a strong, unique `SESSION_SECRET` in production.
- The admin panel is excluded from search engines via `robots.txt` and `noindex` meta tags.
