// render-feed.mjs
// Pre-renders the current public/data.json feed into public/index.html as
// real HTML (between <!--SSR_*--> comment markers), so crawlers, scrapers,
// and link-unfurlers that don't execute JavaScript still see the board's
// actual content — job postings, CFPs, conferences — instead of the empty
// containers the client-side JS would otherwise fill in after fetching
// data.json. The client JS still re-renders over this on every real page
// load (it has to, for filtering/Ask to work), so this only changes what a
// non-JS request or the very first paint sees; real visitors see no
// difference.
//
// Mirrors the render logic in public/index.html's <script> (FACET_DEFS,
// TYPE_HUES, hueColor, dayBucket, formatDateLabel, render/renderFacets) —
// keep the two in sync if that logic changes.
//
// Run after `npm run fetch` (chained in package.json's "fetch" script, so
// both local runs and the daily GitHub Action pick it up automatically).

import { readFile, writeFile } from 'node:fs/promises';

const DATA_PATH = new URL('../public/data.json', import.meta.url);
const INDEX_PATH = new URL('../public/index.html', import.meta.url);
const SITEMAP_PATH = new URL('../public/sitemap.xml', import.meta.url);

const FACET_DEFS = [
  { key: 'typeTags', label: 'Type', hue: 250 },
  { key: 'topicTags', label: 'Topic', hue: 150 },
  { key: 'eventTags', label: 'Event & Conference', hue: 10 },
];
const TYPE_HUES = {
  'Conference & Workshop': 150,
  'Journal & Special Issue': 30,
  'Job Posting': 10,
  'PhD & Funding': 300,
  'General Discussion': 210,
};

function hueColor(hue, l, c) {
  return `oklch(${l} ${c} ${hue === undefined ? 60 : hue})`;
}

function dayBucket(iso, today) {
  const d = new Date(iso);
  const diffDays = Math.floor((today - d) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 6) return 'This week';
  return 'Earlier';
}

function formatDateLabel(iso) {
  // Server has no visitor locale to defer to (client uses toLocaleDateString
  // with `undefined`); this is only ever on screen for the instant before
  // the client re-render replaces it, so a fixed locale is fine.
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// The client builds these nodes with textContent (auto-escaping); we're
// building HTML strings server-side, so escape anything from feed content.
function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Facet sidebar (matches renderFacets() with no filters selected) -----
function renderFacetsHtml(messages) {
  return FACET_DEFS.map(fg => {
    const tally = {};
    messages.forEach(m => (m[fg.key] || []).forEach(t => { tally[t] = (tally[t] || 0) + 1; }));
    const limit = fg.key === 'eventTags' ? 14 : 10;
    const tags = Object.keys(tally).sort((a, b) => tally[b] - tally[a]).slice(0, limit);

    const chips = tags.map(tag => `
      <button class="facet-chip" style="font-weight:500; background:transparent; color:oklch(38% 0.012 60);">
        <span class="box"></span><span class="label">${esc(tag)}</span><span class="count">${tally[tag]}</span>
      </button>`).join('');

    return `
      <div class="facet-group">
        <div class="facet-title">
          <span class="facet-dot" style="background:${hueColor(fg.hue, '55%', '0.14')};"></span>
          <h2>${esc(fg.label)}</h2>
        </div>
        <div class="facet-chips">${chips}</div>
      </div>`;
  }).join('');
}

// --- Feed cards (matches render()'s item markup, no filters selected) ----
function renderCardHtml(m) {
  const repostCount = m.reposts ? m.reposts.length : 1;
  const secondary = (m.topicTags || []).concat(m.eventTags || []).slice(0, 4);
  const href = esc(m.url || 'https://listserv.isworld.org/scripts/wa-ISWORLD.exe?A0=AISWORLD');

  const pills = (m.typeTags || []).map(t => {
    const hue = TYPE_HUES[t] !== undefined ? TYPE_HUES[t] : 60;
    return `<span class="pill" style="background:${hueColor(hue, '92%', '0.03')}; color:${hueColor(hue, '32%', '0.09')};">${esc(t)}</span>`;
  }).join('');

  const repostBadge = repostCount > 1 ? `<span class="repost-badge">posted ${repostCount}×</span>` : '';

  const tagsHtml = secondary.length > 0
    ? `<div class="item-tags">${secondary.map(t => {
        const isEvent = (m.eventTags || []).includes(t);
        return `<span class="item-tag ${isEvent ? 'event' : 'topic'}">${esc(t)}</span>`;
      }).join('')}</div>`
    : '';

  return `
    <a class="item" href="${href}" target="_blank" rel="noopener">
      <div class="item-top">${pills}${repostBadge}<span class="item-date">${esc(formatDateLabel(m.date))}</span></div>
      <div class="item-subject">${esc(m.subject)}</div>
      <span class="item-sender">${esc(m.sender || '')}</span>
      ${tagsHtml}
    </a>`;
}

function renderFeedHtml(messages) {
  const today = new Date();
  const buckets = { Today: [], Yesterday: [], 'This week': [], Earlier: [] };
  messages.forEach(m => buckets[dayBucket(m.date, today)].push(m));

  return ['Today', 'Yesterday', 'This week', 'Earlier']
    .filter(label => buckets[label].length > 0)
    .map(label => `
      <section class="group">
        <h2>${label}</h2>
        <div class="items">${buckets[label].map(renderCardHtml).join('')}</div>
      </section>`)
    .join('');
}

function replaceBetweenMarkers(html, name, replacement) {
  const re = new RegExp(`<!--SSR_${name}_START-->[\\s\\S]*?<!--SSR_${name}_END-->`);
  if (!re.test(html)) throw new Error(`SSR_${name} markers not found in public/index.html`);
  return html.replace(re, `<!--SSR_${name}_START-->${replacement}<!--SSR_${name}_END-->`);
}

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, 'utf-8'));
  const messages = data.messages || [];

  let html = await readFile(INDEX_PATH, 'utf-8');
  html = replaceBetweenMarkers(html, 'FEED', renderFeedHtml(messages));
  html = replaceBetweenMarkers(html, 'FACETS', renderFacetsHtml(messages));

  const updatedText = data.lastUpdated
    ? new Date(data.lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'not yet run';
  html = replaceBetweenMarkers(html, 'UPDATED', esc(updatedText));

  const totalReposts = messages.reduce((sum, m) => sum + (m.reposts ? m.reposts.length : 1), 0);
  html = replaceBetweenMarkers(html, 'COUNTS', `${totalReposts} messages · ${messages.length} unique threads`);

  await writeFile(INDEX_PATH, html, 'utf-8');

  // Keep the sitemap's freshness signal in sync with the data.
  if (data.lastUpdated) {
    let sitemap = await readFile(SITEMAP_PATH, 'utf-8');
    const lastmodDate = data.lastUpdated.slice(0, 10); // YYYY-MM-DD
    sitemap = /<lastmod>/.test(sitemap)
      ? sitemap.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${lastmodDate}</lastmod>`)
      : sitemap.replace('</url>', `  <lastmod>${lastmodDate}</lastmod>\n  </url>`);
    await writeFile(SITEMAP_PATH, sitemap, 'utf-8');
  }

  console.log(`Pre-rendered ${messages.length} threads into index.html and updated sitemap.xml`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
