// fetch-feed.mjs
// Fetches the AISWORLD listserv RSS feed, classifies each post into a topic
// category, merges it into the existing data.json (de-duplicating reposts of
// the same announcement), prunes old entries, and writes public/data.json.
//
// Run manually:   npm install && npm run fetch
// Run on a schedule: see .github/workflows/update.yml (daily cron)

import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const FEED_URL = 'https://listserv.isworld.org/scripts/wa-ISWORLD.exe?RSS&L=AISWORLD&v=2.0&LIMIT=100';
const DATA_PATH = new URL('../public/data.json', import.meta.url);
const CATEGORIES_PATH = new URL('../config/categories.json', import.meta.url);
const RETENTION_DAYS = 60; // drop threads whose most recent post is older than this

function stripHtml(str = '') {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Collapses "Re:", "Fwd:", trailing whitespace/punctuation variance so the
// same announcement posted multiple times maps to one key.
function normalizeSubject(subject = '') {
  return subject
    .toLowerCase()
    .replace(/^\s*(re|fwd?|fw)\s*:\s*/i, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function categorize(text, rules) {
  const lower = text.toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.length === 0) continue; // fallback rule, matched last
    if (rule.keywords.some(k => lower.includes(k))) return rule.id;
  }
  const fallback = rules.find(r => r.keywords.length === 0);
  return fallback ? fallback.id : 'general';
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
  const [{ rules }, existing] = await Promise.all([
    readFile(CATEGORIES_PATH, 'utf-8').then(JSON.parse),
    loadExisting(),
  ]);

  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': 'aisworld-portal-fetch/1.0 (+daily digest bot)' },
  });
  if (!res.ok) {
    throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false });
  const feed = parser.parse(xml);
  const rawItems = feed?.rss?.channel?.item ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  // Index existing threads by normalized subject so reposts merge together.
  const byKey = new Map(existing.messages.map(m => [m.key, m]));

  for (const item of items) {
    const subject = stripHtml(item.title ?? '(no subject)');
    const link = item.link ?? '';
    const dateRaw = item.pubDate ?? item['dc:date'] ?? null;
    const date = dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString();
    const sender = stripHtml(item['dc:creator'] ?? item.author ?? 'Unknown sender');
    const description = stripHtml(item.description ?? '');
    const key = normalizeSubject(subject);
    const category = categorize(`${subject} ${description}`, rules);

    const existingThread = byKey.get(key);
    if (existingThread) {
      if (!existingThread.reposts.includes(date)) {
        existingThread.reposts.push(date);
        existingThread.reposts.sort();
      }
      // Keep the latest link/date/snippet as the thread's primary record.
      if (date > existingThread.date) {
        existingThread.date = date;
        existingThread.url = link || existingThread.url;
        existingThread.snippet = description || existingThread.snippet;
        existingThread.sender = sender || existingThread.sender;
      }
    } else {
      byKey.set(key, {
        key,
        category,
        subject,
        sender,
        date,
        url: link,
        snippet: description,
        reposts: [date],
      });
    }
  }

  // Prune threads not seen recently (feed only carries the last ~100 posts,
  // so anything this old has scrolled out of the window anyway).
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const messages = [...byKey.values()]
    .filter(m => new Date(m.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

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
