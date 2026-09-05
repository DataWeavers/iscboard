// Cloudflare Worker — LLM search proxy for the Information Systems Community Board.
//
// The browser does cheap keyword pre-filtering on data.json first, then POSTs
// only the handful of plausibly-relevant posts here. This Worker adds the
// (server-side, never exposed) API key and asks the model to draft an answer
// that cites ONLY those posts. Keeping the key here is the whole point — a
// static GitHub Pages site can't hold a secret, this can.
//
// Default backend: OpenAI GPT-5 nano (very cheap — ~$0.05/M in, $0.40/M out —
// and, being a paid endpoint, not subject to the free-tier "high demand"
// throttling that Gemini's free tier hits). At this board's volume the cost
// is a few cents a month. To swap to Gemini/Claude, see the ALTERNATE
// BACKEND block near the bottom.
//
// ---- Deploy (one time) --------------------------------------------------
//   1. https://dash.cloudflare.com  ->  Workers & Pages  ->  Create  ->  Worker
//   2. Paste this file as the Worker code, Deploy.
//   3. Worker  ->  Settings  ->  Variables and Secrets  ->  add a SECRET:
//        Name:  OPENAI_API_KEY      Value: <your OpenAI API key>
//      (Use "Encrypt" / Secret, NOT a plaintext variable. The key must never
//       live in this file or the git repo.)
//   4. Copy the Worker URL (e.g. https://iscboard-search.<you>.workers.dev)
//      and paste it into WORKER_URL in index.html and the .dc.html.
//   5. Update ALLOWED_ORIGINS below with the origin(s) the site is served
//      from. Requests from any other origin are rejected — this is what
//      stops someone else's page from calling your worker (and burning your
//      OpenAI credits) directly. Add a local dev origin (e.g.
//      'http://localhost:3000') while testing with `npx serve public`, and
//      remove it again before deploying.
//   6. (Optional, recommended) Create a Workers KV namespace and bind it as
//      RATE_LIMIT_KV (Worker -> Settings -> Bindings -> KV Namespace) to cap
//      requests per visitor IP. Without this binding the worker still works,
//      it just skips rate-limiting.
//
// Create the key at https://platform.openai.com/api-keys (a billing method is
// required, but usage at this volume is negligible). Note: OpenAI does not use
// API data to train its models by default.
// -------------------------------------------------------------------------

const MODEL = 'gpt-5-nano';
const MAX_POSTS = 40;      // hard cap on what we'll accept from the client
const SNIPPET_CHARS = 700; // trim each post body before sending to the model
const MAX_RETRIES = 3;     // on transient 429/500/503

// Only these origins may call this worker. A static site's WORKER_URL is
// visible in its client-side JS, so without this check anyone could script
// requests straight at the worker (bypassing the board entirely) and spend
// the OpenAI budget behind OPENAI_API_KEY. Keep this list to the site's real
// origin(s); the Origin header is attacker-controllable outside a browser,
// so treat this as a basic deterrent, not a hard security boundary — the KV
// rate limit below is the actual backstop.
const ALLOWED_ORIGINS = [
  'https://dataweavers.github.io',
];

const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 20;    // per IP, per window

// Fixed-window per-IP rate limit backed by an optional RATE_LIMIT_KV
// binding. Returns true when the caller is over the limit. Skips limiting
// (returns false) when no KV namespace is bound, so the worker keeps
// working with zero extra setup.
async function isRateLimited(kv, ip) {
  if (!kv) return false;
  const windowStart = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `rl:${ip}:${windowStart}`;
  const current = parseInt((await kv.get(key)) || '0', 10);
  if (current >= RATE_LIMIT_MAX_REQUESTS) return true;
  await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS + 60 });
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const originAllowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originAllowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
    if (!originAllowed) return json({ error: 'Origin not allowed' }, 403, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await isRateLimited(env.RATE_LIMIT_KV, ip)) {
      return json({ error: 'Too many requests — please wait a bit and try again.' }, 429, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, cors);
    }

    // The client (public/index.html) sends the full conversation as
    // `history` — an array of {role, content} turns, the last of which is
    // the current question. Pull the query out of it (falling back to a
    // bare `body.query` for older/simpler clients) instead of requiring a
    // separate top-level field.
    const history = Array.isArray(body.history) ? body.history : [];
    let posts = Array.isArray(body.posts) ? body.posts.slice(0, MAX_POSTS) : [];

    let query = '';
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i];
      if (turn && turn.role === 'user' && typeof turn.content === 'string') {
        query = turn.content.slice(0, 500).trim();
        break;
      }
    }
    if (!query) query = (body.query || '').toString().slice(0, 500).trim();
    if (!query) return json({ error: 'Empty query' }, 400, cors);

    if (posts.length === 0) {
      return json({ answer: "I couldn't find any posts related to that. Try different or broader keywords." }, 200, cors);
    }

    const context = posts.map((p, i) => {
      const tags = [...(p.typeTags || []), ...(p.topicTags || []), ...(p.eventTags || [])].join(', ');
      return `[${i + 1}] ${p.subject}\n` +
        `Date: ${(p.date || '').slice(0, 10)}\n` +
        `Tags: ${tags || '—'}\n` +
        `Link: ${p.url || ''}\n` +
        `Summary: ${(p.snippet || '').slice(0, SNIPPET_CHARS)}`;
    }).join('\n\n');

    const system =
      "You are a concise research assistant for a board of Information Systems academic " +
      "community posts (from the AISWORLD mailing list). Answer the user's question using " +
      "ONLY the numbered posts provided. Do not invent posts, links, deadlines, or facts " +
      "that are not in the posts. If none of the posts are relevant, say so plainly.\n\n" +
      "Formatting rules:\n" +
      "- Keep it short: a 1-2 sentence lead, then a short list of the most relevant posts.\n" +
      "- For every post you reference, link its title using markdown with the EXACT Link " +
      "URL given for that post: [Post title](url).\n" +
      "- Never output a URL that was not provided. Never link the same post twice.\n" +
      "- If the user asks about deadlines/dates, only state ones that appear in the summaries.";

    const userContent = `Question: ${query}\n\nPosts:\n${context}`;

    // Prior turns (everything in `history` except the current question,
    // which is its last entry) give the model real conversation memory for
    // follow-ups. The current turn gets the post context appended instead
    // of being replayed verbatim, since the accumulated post set can grow
    // between turns (see askedPosts in index.html).
    const priorTurns = history
      .slice(0, -1)
      .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
      .map(t => ({ role: t.role, content: t.content.slice(0, 4000) }));

    const messages = [
      { role: 'system', content: system },
      ...priorTurns,
      { role: 'user', content: userContent },
    ];

    // ---- OpenAI GPT-5 nano (default) --------------------------------------
    // Chat Completions endpoint. GPT-5 nano is a reasoning model; for this
    // simple retrieve-and-cite task keep reasoning minimal to cut latency.
    const endpoint = 'https://api.openai.com/v1/chat/completions';

    const callModel = async () => {
      const payload = {
        model: MODEL,
        max_completion_tokens: 1024,
        reasoning_effort: 'minimal',
        messages,
      };
      return fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Retry on transient 429/500/502/503 with backoff.
    let resp = null;
    let lastDetail = '';
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const r = await callModel();
        if (r.ok) { resp = r; break; }
        if ([429, 500, 502, 503].includes(r.status)) {
          lastDetail = (await r.text().catch(() => '')).slice(0, 300);
          await sleep(400 * (attempt + 1));
          continue;
        }
        lastDetail = (await r.text().catch(() => '')).slice(0, 300);
        break; // non-transient error
      } catch (e) {
        lastDetail = 'network error';
        await sleep(400 * (attempt + 1));
      }
    }

    if (!resp) {
      return json({ error: 'The assistant is busy right now. Please try again in a moment.', detail: lastDetail }, 503, cors);
    }

    const data = await resp.json().catch(() => null);
    const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
      ? data.choices[0].message.content
      : "Sorry — I couldn't generate an answer just now.";

    return json({ answer }, 200, cors);
  },
};

// ---- ALTERNATE BACKEND: Google Gemini (has a free tier) -----------------
// To use Gemini instead of OpenAI, store the secret as GEMINI_API_KEY and
// replace the "OpenAI GPT-5 nano (default)" block's endpoint/callModel with:
//
//   const endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
//   const callModel = async () => fetch(endpoint, {
//     method: 'POST',
//     headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GEMINI_API_KEY}` },
//     body: JSON.stringify({
//       model: 'gemini-2.5-flash',   // GA/stable; or 'gemini-3.5-flash'
//       max_tokens: 1024,
//       reasoning_effort: 'low',
//       messages, // same system + priorTurns + current-turn array built above
//     }),
//   });
//   // response shape is the same (data.choices[0].message.content)
//
// ---- ALTERNATE BACKEND: Anthropic Claude / Meta Muse Spark --------------
// Both speak the Anthropic Messages format. Store the secret as
// ANTHROPIC_API_KEY and use:
//
//   const payload = {
//     model: 'claude-3-5-haiku-latest',   // or Muse: base URL https://api.meta.ai/v1, model 'muse-spark-1.1'
//     max_tokens: 1024,
//     system,
//     messages: [...priorTurns, { role: 'user', content: userContent }], // Anthropic takes `system` separately, not inside `messages`
//   };
//   resp = await fetch('https://api.anthropic.com/v1/messages', {
//     method: 'POST',
//     headers: {
//       'content-type': 'application/json',
//       'x-api-key': env.ANTHROPIC_API_KEY,
//       'anthropic-version': '2023-06-01',
//     },
//     body: JSON.stringify(payload),
//   });
//   // and read the answer from: data.content[0].text
// -------------------------------------------------------------------------

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}
