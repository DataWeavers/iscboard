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
//
// Create the key at https://platform.openai.com/api-keys (a billing method is
// required, but usage at this volume is negligible). Note: OpenAI does not use
// API data to train its models by default.
// -------------------------------------------------------------------------

const MODEL = 'gpt-5-nano';
const MAX_POSTS = 40;      // hard cap on what we'll accept from the client
const SNIPPET_CHARS = 700; // trim each post body before sending to the model
const MAX_RETRIES = 3;     // on transient 429/500/503

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, cors);
    }

    const query = (body.query || '').toString().slice(0, 500).trim();
    let posts = Array.isArray(body.posts) ? body.posts.slice(0, MAX_POSTS) : [];
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

    // ---- OpenAI GPT-5 nano (default) --------------------------------------
    // Chat Completions endpoint. GPT-5 nano is a reasoning model; for this
    // simple retrieve-and-cite task keep reasoning minimal to cut latency.
    const endpoint = 'https://api.openai.com/v1/chat/completions';

    const callModel = async () => {
      const payload = {
        model: MODEL,
        max_completion_tokens: 1024,
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
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
//       messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
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
//     messages: [{ role: 'user', content: userContent }],
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
