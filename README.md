# AISWORLD Digest Portal

A static portal that clusters posts from the AISWORLD mailing list into
topic categories (Calls for Papers, Conferences & Workshops, Journal /
Special Issues, Jobs & Recruiting, PhD & Funding, General Discussion),
de-duplicates reposts of the same announcement, and links out to the full
message on the listserv archive.

It has two parts:

- `public/` — the site itself. `index.html` reads `data.json` and renders
  the feed. This is the only folder your host needs to serve.
- `scripts/fetch-feed.mjs` — a Node script that pulls the AISWORLD RSS feed,
  classifies each post, merges reposts, and rewrites `public/data.json`.
  This has to run **server-side** (a browser can't fetch the listserv feed
  directly — no CORS headers), which is what the included GitHub Action is for.

## 1. Deploy the site

Push this folder to a GitHub repo, then point your static host at it,
serving the `public/` folder as the site root:

- **Any Git-connected static host** (Netlify, Vercel, Cloudflare Pages, or
  lmu.build if it supports Git-based deploys): set the publish/output
  directory to `public`, no build command needed — it's plain HTML/CSS/JS.
- **GitHub Pages**: Settings → Pages → deploy from the `public` folder
  (or a `gh-pages` branch built from it).
- Any plain file host: just upload the contents of `public/` — `data.json`
  lives alongside `index.html`.

## 2. Automate daily updates

`.github/workflows/update.yml` runs on a daily cron (`0 12 * * *` UTC by
default — edit that line to change the time), fetches the feed, rebuilds
`public/data.json`, and commits it back to the repo.

If your host auto-redeploys on push (true for Netlify/Vercel/Cloudflare
Pages/GitHub Pages by default), the live site updates automatically the
next day — no manual step required.

To turn this on:
1. Push this repo to GitHub.
2. Go to the repo's **Settings → Actions → General** and make sure
   "Read and write permissions" is enabled for the `GITHUB_TOKEN` (needed
   so the workflow can commit `data.json` back).
3. That's it — it'll run automatically on schedule. You can also trigger
   it manually from the **Actions** tab (`Run workflow`).

## 3. Run it yourself / test locally

```bash
npm install
npm run fetch          # fetches the feed, writes public/data.json
npx serve public       # or any static file server, then open the printed URL
```

## Tuning categorization

Edit `config/categories.json`. Each rule lists keywords tested against the
post's subject + description; the first rule with a match wins, in file
order, with the empty-keyword rule (General Discussion) as the catch-all.
No code changes needed — just add/remove keywords and re-run the fetch.

## How de-duplication works

Announcements are often re-posted verbatim over several weeks. The fetch
script strips `Re:`/`Fwd:` prefixes and punctuation from the subject line
to build a dedup key; posts sharing a key are merged into one thread, with
each occurrence's date recorded (shown as "posted 3×" etc.) and the link
pointing at the most recent occurrence. Threads whose most recent post is
older than 60 days are pruned from `data.json` (tune `RETENTION_DAYS` in
`scripts/fetch-feed.mjs`).
