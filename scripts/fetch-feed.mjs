// fetch-feed.mjs
// Fetches the AISWORLD listserv RSS feed, tags each post along three facets
// (Type / Topic / Event — see computeTypeTags / computeTopicTags /
// computeEventTags below), merges it into the existing data.json
// (de-duplicating reposts of the same announcement), prunes old entries, and
// writes public/data.json.
//
// Run manually:   npm install && npm run fetch
// Run on a schedule: see .github/workflows/update.yml (daily cron)

import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const FEED_URL = 'https://listserv.isworld.org/scripts/wa-ISWORLD.exe?RSS&L=AISWORLD&v=2.0&LIMIT=100';
const DATA_PATH = new URL('../public/data.json', import.meta.url);
const CATEGORIES_PATH = new URL('../config/categories.json', import.meta.url);
const TOPICS_PATH = new URL('../config/topics.json', import.meta.url);
const RETENTION_DAYS = 90; // drop threads whose most recent post is older than this

function stripHtml(str = '') {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// The AISWORLD listserv sends a daily "AISWORLD Index" digest e-mail that
// lists every post's subject line; when someone REPLIES to that digest
// (e.g. to ask to unsubscribe, or to comment on the list itself), the RSS
// description for their reply is the entire quoted digest body — full of
// OTHER people's post subjects ("CALL for PAPERS", "Workshop", "Conference"
// ...). Tagging on that text mistags an unrelated admin note as a real
// announcement. Cut the snippet at the first sign of a quoted digest before
// any keyword matching runs.
const DIGEST_QUOTE_RE = /AISWORLD Index\b/i;
function stripQuotedDigest(text) {
  const idx = text.search(DIGEST_QUOTE_RE);
  return idx === -1 ? text : text.slice(0, idx).trim();
}

// List-management requests (unsubscribe/subscribe/signoff) are pure admin
// noise, never a real announcement — skipped entirely rather than shown as
// a post (see the `continue` in the main loop below).
const ADMIN_SUBJECT_RE = /\bunsu[bs]?scribe\b|\bsubscribe\b|\bsignoff\b|\bsign off\b|\bleave the list\b|\bremove me\b/i;

// Collapses "Re:", "Fwd:", "AW:" (the German reply prefix), trailing
// whitespace/punctuation variance so the same announcement posted multiple
// times maps to one key.
function normalizeSubject(subject = '') {
  return subject
    .toLowerCase()
    .replace(/^\s*(re|fwd?|fw|aw)\s*:\s*/i, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Fuzzy repost detection ---------------------------------------------
// Some reposts get reworded enough (emoji swapped in, "Last Call" ->
// "Extended Deadline", underscores -> spaces) that normalizeSubject()'s exact
// key won't catch them. We catch those with trigram similarity, but subject
// similarity ALONE is unreliable: two unrelated one-line replies in the same
// email thread (e.g. "Re: X" / "AW: X") can score 100% on a short subject
// while discussing completely different things. Requiring the full message
// body to ALSO be similar is what actually distinguishes "same announcement,
// reworded" from "different message, similarly-titled" (e.g. a conference's
// six distinct per-track CFPs, which share boilerplate but aren't dupes).
const FUZZY_SUBJECT_THRESHOLD = 0.6;
const FUZZY_BODY_THRESHOLD = 0.65;
// Pairs below the auto-merge bar but above this are logged for a human to
// check rather than silently merged (or silently left as two entries).
const FUZZY_REVIEW_THRESHOLD = 0.4;

function trigrams(str = '') {
  const clean = str.toLowerCase().replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 2; i++) grams.add(clean.slice(i, i + 3));
  return grams;
}

function diceCoefficient(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

// Distinguishes "same announcement, reworded" from "different event, same
// template" — e.g. one organizer's near-identical CFP boilerplate sent out
// separately for DSCI-2026 and IOI-2026 scores high on both thresholds above
// despite being two different conferences. Pulls each subject's "ACRONYM
// 20XX" identifier(s) (normalizing underscores/hyphens so "CFP_MoMM2026_..."
// and "MoMM 2026" both expose "momm"); if both subjects name at least one
// such identifier and none match, they're different events — block the
// merge no matter how similar the wording is.
const MONTH_WORDS = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december',
]);

function extractEventIdentifiers(subject = '') {
  const normalized = subject.replace(/[^a-zA-Z0-9]+/g, ' ');
  const re = /\b([a-zA-Z]{2,12})\s?(20\d{2})\b/g;
  const ids = new Set();
  let m;
  while ((m = re.exec(normalized))) {
    const id = m[1].toLowerCase();
    if (!MONTH_WORDS.has(id)) ids.add(id);
  }
  return ids;
}

function sameNamedEvent(idsA, idsB) {
  if (idsA.size === 0 || idsB.size === 0) return true; // nothing to contradict on
  for (const id of idsA) if (idsB.has(id)) return true;
  return false;
}

// Scans all threads for reworded reposts of the same announcement. Mutates
// nothing; returns { merges: [[keepIndex, dropIndex], ...], review: [...] }.
function findFuzzyDuplicates(messages) {
  const subjTri = messages.map(m => trigrams(normalizeSubject(m.subject)));
  const bodyTri = messages.map(m => trigrams(m.snippet));
  const eventIds = messages.map(m => extractEventIdentifiers(m.subject));
  const merges = [];
  const review = [];

  for (let i = 0; i < messages.length; i++) {
    for (let j = i + 1; j < messages.length; j++) {
      const subjSim = diceCoefficient(subjTri[i], subjTri[j]);
      const bodySim = diceCoefficient(bodyTri[i], bodyTri[j]);
      const plausiblySameEvent = sameNamedEvent(eventIds[i], eventIds[j]);
      if (subjSim >= FUZZY_SUBJECT_THRESHOLD && bodySim >= FUZZY_BODY_THRESHOLD && plausiblySameEvent) {
        merges.push([i, j, subjSim, bodySim]);
      } else if (plausiblySameEvent && (subjSim >= FUZZY_REVIEW_THRESHOLD || bodySim >= FUZZY_REVIEW_THRESHOLD)) {
        review.push([i, j, subjSim, bodySim]);
      }
    }
  }
  return { merges, review };
}

// --- Type tags ------------------------------------------------------------
// Every rule whose pattern matches applies. Falls back to General Discussion
// only when nothing else matched.
//
// One more inference on top of the keyword rules: a detected venue acronym
// (computeEventTags — HICSS, AMCIS, WPMC, ...) is a strong enough signal on
// its own that the post is conference/workshop-related even when the body
// never uses those literal words (some RSS entries are just a stub linking
// out to the full message, or the text focuses on the topic and never
// names the event format).
function computeTypeTags(text, rules, eventTags) {
  const hits = rules.filter(r => r.pattern && new RegExp(r.pattern, 'i').test(text)).map(r => r.label);
  if (!hits.includes('Conference & Workshop') && eventTags.length > 0) {
    hits.push('Conference & Workshop');
  }
  if (hits.length === 0) {
    const fallback = rules.find(r => !r.pattern);
    return fallback ? [fallback.label] : ['General Discussion'];
  }
  return hits;
}

// --- Topic tags -------------------------------------------------------
// Cross-cutting and independent of type — a post can be both "AI & GenAI"
// and "Cybersecurity & Privacy" (config/topics.json).
function computeTopicTags(text, topics) {
  const lower = text.toLowerCase();
  return topics.filter(t => t.keywords.some(k => lower.includes(k))).map(t => t.label);
}

// "ACRONYM 20XX" / "ACRONYM_20XX" pattern — covers the vast majority of CFP
// and conference subjects (ICSOC 2026, DSCI-2026, MoMM2026, ...). Requires
// the matched token to actually look like an acronym by ORIGINAL casing
// (ALLCAPS, or an internal lower->upper transition like "iiWAS"/"MoMM"/"WeB")
// so ordinary Title Case words ("Conference 2026", "the 2026 Workshop") don't
// get mistaken for venue names.
function looksAcronymLike(token) {
  if (/^[A-Z0-9]+$/.test(token)) return true;
  if (/[a-z][A-Z]/.test(token)) return true;
  return false;
}

function extractRawIdentifiers(subject) {
  const normalized = subject.replace(/[^a-zA-Z0-9]+/g, ' ');
  const re = /\b([a-zA-Z]{2,12})\s?(20\d{2})\b/g;
  const out = [];
  let m;
  while ((m = re.exec(normalized))) {
    const raw = m[1];
    if (MONTH_WORDS.has(raw.toLowerCase())) continue;
    if (!looksAcronymLike(raw)) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

// Fallback for acronym+ordinal forms with no year in the subject at all
// (e.g. "HICSS-60", "HICSS 60") — only fires for ALLCAPS tokens, since that's
// the one reliable signal separating a real acronym from an ordinary word
// that happens to precede a number.
function extractVenueTags(subject) {
  const ids = extractRawIdentifiers(subject).map((s) => s.toUpperCase());
  const ord = subject.match(/\b([A-Z]{2,10})[-\s](\d{2,3})\b/);
  if (ord && !ids.includes(ord[1])) ids.push(ord[1]);
  // "pre-ICIS" / "pre AMCIS" side events tag the base venue even with no year
  // attached (these subjects rarely repeat the year next to the acronym).
  const preRe = /\bpre[-\s]?([A-Za-z]{2,10})\b/gi;
  let pm;
  while ((pm = preRe.exec(subject))) {
    const code = pm[1].toUpperCase();
    if (looksAcronymLike(pm[1]) && !ids.includes(code)) ids.push(code);
  }
  return ids;
}

// --- Event tags --------------------------------------------------------
// Venue codes (HICSS, ISSRE, AMCIS, ICIS, ...) pulled straight from the
// subject. A subject can name more than one (e.g. a joint AMCIS + ICIS
// call), so we keep every distinct one, not just the first.
function computeEventTags(subject) {
  return extractVenueTags(subject);
}

async function loadExisting() {
  if (!existsSync(DATA_PATH)) return { messages: [] };
  try {
    const raw = await readFile(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { messages: [] };
  }
}

async function main() {
  const [{ rules }, { topics }, existing] = await Promise.all([
    readFile(CATEGORIES_PATH, 'utf-8').then(JSON.parse),
    readFile(TOPICS_PATH, 'utf-8').then(JSON.parse),
    loadExisting(),
  ]);

  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': 'aisworld-portal-fetch/1.0 (+daily digest bot)' },
  });
  if (!res.ok) {
    throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();

  // processEntities:{} removes the (relatively low) default cap on total
  // entity expansions — RSS descriptions with lots of escaped HTML
  // (&lt;, &amp;, etc.) can easily exceed the library's default limit.
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: {} });
  const feed = parser.parse(xml);
  const rawItems = feed?.rss?.channel?.item ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  // Index existing threads by normalized subject so reposts merge together.
  const byKey = new Map(existing.messages.map(m => [m.key, m]));

  for (const item of items) {
    const subject = stripHtml(item.title ?? '(no subject)');
    if (ADMIN_SUBJECT_RE.test(subject)) continue; // list-admin noise (unsubscribe/subscribe/signoff) — not a real post, skip entirely
    const link = item.link ?? '';
    const dateRaw = item.pubDate ?? item['dc:date'] ?? null;
    const date = dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString();
    const sender = stripHtml(item['dc:creator'] ?? item.author ?? 'Unknown sender');
    const description = stripQuotedDigest(stripHtml(item.description ?? ''));
    const key = normalizeSubject(subject);
    const eventTags = computeEventTags(subject);
    const typeTags = computeTypeTags(`${subject} ${description}`, rules, eventTags);
    const topicTags = computeTopicTags(`${subject} ${description}`, topics);

    const existingThread = byKey.get(key);
    if (existingThread) {
      if (!existingThread.reposts.includes(date)) {
        existingThread.reposts.push(date);
        existingThread.reposts.sort();
      }
      // Recompute tags fresh from the CURRENT rules on every fetch (no union
      // with previously-stored tags). This is what makes tag/category rule
      // changes self-heal: any thread still in the feed window is re-tagged
      // from scratch on the next run instead of carrying stale tags forever.
      // Tags follow the newest post's text — if this incoming repost is the
      // latest, its text (and tags) become the thread's record; otherwise we
      // keep the tags already derived from the newer post we have.
      if (date >= existingThread.date) {
        existingThread.typeTags = typeTags;
        existingThread.topicTags = topicTags;
        existingThread.eventTags = eventTags;
        existingThread.date = date;
        existingThread.url = link || existingThread.url;
        existingThread.snippet = description || existingThread.snippet;
        existingThread.sender = sender || existingThread.sender;
      }
    } else {
      byKey.set(key, {
        key,
        subject,
        sender,
        date,
        url: link,
        snippet: description,
        typeTags,
        topicTags,
        eventTags,
        reposts: [date],
      });
    }
  }

  // Prune threads not seen recently (feed only carries the last ~100 posts,
  // so anything this old has scrolled out of the window anyway).
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  let messages = [...byKey.values()]
    .filter(m => new Date(m.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // Second pass: catch reposts whose subject was reworded enough to dodge
  // the exact-key merge above (see findFuzzyDuplicates for the threshold
  // rationale). Union-find style: repeatedly fold the highest-confidence
  // pair together until none remain, keeping the thread with the newer date
  // as the surviving record and carrying over the other's repost history.
  let fuzzy = findFuzzyDuplicates(messages);
  while (fuzzy.merges.length > 0) {
    const [i, j] = fuzzy.merges[0];
    const [keep, drop] = new Date(messages[i].date) >= new Date(messages[j].date)
      ? [messages[i], messages[j]]
      : [messages[j], messages[i]];
    const mergedReposts = [...new Set([...keep.reposts, ...drop.reposts])].sort();
    // Keep the surviving (newer) record's freshly-computed tags — consistent
    // with the fresh-retag policy above; don't union in the dropped dupe's.
    const merged = {
      ...keep,
      reposts: mergedReposts,
    };
    messages = messages
      .filter(m => m !== messages[i] && m !== messages[j])
      .concat(merged)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    fuzzy = findFuzzyDuplicates(messages);
  }
  if (fuzzy.review.length > 0) {
    console.log(`\n${fuzzy.review.length} possible-duplicate pair(s) below the auto-merge bar — check manually:`);
    for (const [i, j, subjSim, bodySim] of fuzzy.review) {
      console.log(`  [subj ${subjSim.toFixed(2)} / body ${bodySim.toFixed(2)}]`);
      console.log(`    A: ${messages[i].subject}`);
      console.log(`    B: ${messages[j].subject}`);
    }
  }

  const output = {
    lastUpdated: new Date().toISOString(),
    messages,
  };

  await writeFile(DATA_PATH, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${messages.length} threads (${items.length} items in this fetch) to public/data.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
