# About ISC Board

## About Me

I'm Arvin Mesgari, an IS educator, researcher, and tech enthusiast who's
been reading AISWORLD for years. My research sits at the intersection of
online communities, sensemaking, and technology affordances, which is
more or less what this project turned into.

Like a lot of you, I love the AISWORLD list but also drown in it.
Duplicates everywhere, and the good stuff gets buried fast. I kept craving
an easier way to browse the content I actually care about. Then AI
happened, and I figured I'd take a stab at it. It became a passion project
and a fun excuse to see AI-assisted web dev in action.

This board is the result: a tagged, de-duplicated view of the list with
just the bare bones of each post, plus links back to the original archive.
It's not meant to replace or compete with the mailing list. My hope is
that it makes the content easier to access and brings the list a broader
audience of academics and practitioners.

If you have feedback or ideas, send them my way through the website.

## What it does

ISC Board is a read-only, unofficial companion to the AISWORLD mailing
list. AISWORLD is high-volume and hard to skim by email — this project
pulls the public feed, cleans it up, and presents it as a filterable
board so you can jump straight to the calls for papers, conferences, jobs,
or funding posts you care about.

It does not host the mailing list, send email, or let anyone post — it
only reads and re-presents what AISWORLD already publishes publicly.

## How the pipeline works

**1. Fetching.** A script (`scripts/fetch-feed.mjs`) pulls the AISWORLD
public RSS feed on a daily schedule (via a GitHub Action cron job) and
rebuilds `public/data.json`, which the site reads.

**2. Categorization ("Type" tags).** Each post's subject + description is
checked against a set of keyword/regex rules in `config/categories.json`
— e.g. "conference", "workshop", "tenure-track", "fellowship". Every rule
that matches applies, so a post can be tagged with more than one Type
(a call for a specific conference legitimately gets both). A post that
matches nothing falls back to "General Discussion." A post with a
recognized event acronym (see below) also automatically gets "Conference
& Workshop," even if the body text never uses that word.

**3. Topic and Event tags.** Beyond Type, posts are tagged with subject
matter (e.g. "AI & GenAI," "Cybersecurity & Privacy") and, when detectable,
the specific event/venue acronym (e.g. "AMCIS," "HICSS"). These three tag
groups — Type, Topic, Event — are independent facets: picking tags within
a group is an OR (any match), across groups is an AND (must satisfy each
group you've filtered on).

**4. De-duplication.** AISWORLD threads are often reposted verbatim over
several weeks. The subject line is normalized (stripping "Re:"/"Fwd:" and
punctuation) into a dedup key; posts sharing a key are merged into a
single card, with every occurrence's date kept (shown as "posted 3×") and
the link pointing at the most recent occurrence.

**5. Retention.** Threads whose most recent post is older than 90 days
are dropped from `data.json` to keep the board current (`RETENTION_DAYS`
in `scripts/fetch-feed.mjs`).

Tuning any of this — adding a keyword, changing retention, adjusting
dedup — only requires editing `config/categories.json` or the constants
at the top of `fetch-feed.mjs`; no rebuild step beyond the daily cron.

## Feedback

Use the "Send feedback" link on the site, or the contact form in the
footer — both go straight to me.

## Ask (AI search)

The board has an AI search box: a visitor types a question, the browser
does a cheap keyword pre-filter over the current posts, sends only the
handful of relevant ones to a small proxy, and the proxy asks a language
model to draft an answer that links **only** to those posts. This keeps
cost and latency flat no matter how big the board grows — the model never
sees the whole dataset, just the slice that matches the query. It's a
multi-turn conversation: visitors can ask follow-up questions and the
prior turns (plus the accumulated posts) stay in context.

The proxy is a Cloudflare Worker (`worker/search-worker.js`) — needed
because a static GitHub Pages site can't safely hold the model API key.
The Worker holds the key server-side and calls the **OpenAI API**, which
isn't subject to the free-tier throttling that Gemini's free tier hits.
Gemini (free tier), Claude, and Muse Spark alternatives are documented in
the worker file.

## Setup & deploy

- `public/` — the site itself; the only folder your host needs to serve.
- `scripts/fetch-feed.mjs` — pulls the feed, tags, dedupes, and rewrites `public/data.json`. Runs server-side via the included GitHub Action (`.github/workflows/update.yml`, daily cron).
- `worker/search-worker.js` — optional Cloudflare Worker for the AI search box (see "Ask" above).
- Deploy `public/` to GitHub Pages (or any static host); the Action commits fresh data and redeploys automatically.
- Local test: `npm install && npm run fetch && npx serve public`.
