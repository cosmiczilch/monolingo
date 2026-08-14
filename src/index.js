/**
 * Monolingo — Telegram bot that captures fancy words, enriches them with
 * Claude, and commits them to words.json in a GitHub repo.
 *
 * Flow: Telegram webhook -> allowlist check -> Claude enrichment ->
 *       GitHub contents API commit -> confirmation reply.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Read API for the flashcard PWA
    if (request.method === "GET" && url.pathname === "/api/words") {
      if (!env.APP_KEY) {
        return jsonResponse({ error: "APP_KEY not configured" }, 503);
      }
      if (url.searchParams.get("key") !== env.APP_KEY) {
        return jsonResponse({ error: "invalid key" }, 401);
      }
      const { words } = await readWords(env);
      return jsonResponse({ words, count: words.length });
    }

    if (request.method !== "POST") {
      return new Response("monolingo bot is running", { status: 200 });
    }

    // Verify the request really comes from Telegram
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const update = await request.json().catch(() => null);
    const message = update && update.message;
    if (message && typeof message.text === "string") {
      // Ack Telegram immediately; do the slow work (Claude + GitHub) after.
      ctx.waitUntil(
        handleMessage(message, env).catch((err) =>
          reportError(message.chat.id, err, env)
        )
      );
    }
    return new Response("ok");
  },
};

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from && message.from.id;
  const firstName = (message.from && message.from.first_name) || "someone";
  let text = message.text.trim();

  // Allowlist: if unset, help the owner discover their ID; otherwise enforce.
  const allowed = (env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) {
    await sendMessage(
      chatId,
      `Hi! I'm not configured yet.\nYour Telegram user ID is <code>${userId}</code>.\n` +
        `Add it to <code>ALLOWED_USER_IDS</code> in wrangler.toml and redeploy.`,
      env
    );
    return;
  }
  if (!allowed.includes(String(userId))) {
    return; // silently ignore strangers
  }

  // In group chats, only react to messages that start with "+" or "/add"
  // so normal conversation doesn't get captured as words.
  const isGroup = message.chat.type !== "private";
  if (text.startsWith("/add")) {
    text = text.slice(4).replace(/^@\w+/, "").trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  } else if (isGroup) {
    return;
  }

  if (text === "/start" || text === "/help" || text === "") {
    await sendMessage(
      chatId,
      `<b>Monolingo</b> — send me a fancy word and I'll add it to the list.\n\n` +
        `In a DM: just send the word (or a sentence containing it).\n` +
        `In a group: prefix with <code>+</code> or use <code>/add word</code>.\n\n` +
        `I'll reply with the definition, synonyms, and examples once it's saved.`,
      env
    );
    return;
  }
  if (text.startsWith("/")) {
    await sendMessage(chatId, `Unknown command. Try /help.`, env);
    return;
  }

  // 1. Enrich with Claude
  const entry = await enrichWord(text, env);
  entry.added_by = firstName;
  entry.added_on = new Date().toISOString().slice(0, 10);

  // 2. Commit to GitHub (retry once on concurrent-write conflict)
  let result;
  try {
    result = await appendWord(entry, env);
  } catch (err) {
    if (err.status === 409) {
      result = await appendWord(entry, env);
    } else {
      throw err;
    }
  }

  // 3. Confirm
  if (result.duplicate) {
    const d = result.duplicate;
    await sendMessage(
      chatId,
      `<b>${escapeHtml(d.word)}</b> is already on the list — added by ` +
        `${escapeHtml(d.added_by)} on ${d.added_on}.\n\n<i>${escapeHtml(d.definition)}</i>`,
      env
    );
    return;
  }

  const syns = entry.synonyms.map(escapeHtml).join(", ");
  const examples = entry.examples
    .map((e) => `• <i>${escapeHtml(e)}</i>`)
    .join("\n");
  await sendMessage(
    chatId,
    `<b>${escapeHtml(entry.word)}</b>\n${escapeHtml(entry.definition)}\n\n` +
      `<b>Synonyms:</b> ${syns}\n<b>Examples:</b>\n${examples}\n\n` +
      `Saved as word #${result.count} ✓`,
    env
  );
}

/* ------------------------------------------------------------------ */
/* Claude enrichment                                                   */
/* ------------------------------------------------------------------ */

async function enrichWord(input, env) {
  const system =
    `You are a lexicographer's assistant. The user sends either a single word ` +
    `or a sentence containing a notable "fancy" word. Identify the word and ` +
    `respond with ONLY a JSON object (no markdown fences, no commentary):\n` +
    `{"word": "<the word, lowercase, lemma form>",\n` +
    ` "definition": "<concise definition, one sentence>",\n` +
    ` "synonyms": ["<2-3 synonyms or closely related words>"],\n` +
    ` "examples": ["<2 short example sentences>"]}\n` +
    `If the user's input was a full sentence, use it (lightly cleaned up) as ` +
    `one of the examples. If the input is not a real word, respond with ` +
    `{"error": "<brief explanation>"}.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-haiku-4-5",
      max_tokens: 500,
      system,
      messages: [{ role: "user", content: input }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Claude API error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const raw = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    throw new Error(`Could not parse enrichment response: ${raw.slice(0, 200)}`);
  }
  if (parsed.error) {
    const err = new Error(parsed.error);
    err.userFacing = true;
    throw err;
  }
  if (!parsed.word || !parsed.definition) {
    throw new Error("Enrichment response missing required fields.");
  }
  parsed.synonyms = Array.isArray(parsed.synonyms) ? parsed.synonyms : [];
  parsed.examples = Array.isArray(parsed.examples) ? parsed.examples : [];
  return parsed;
}

/* ------------------------------------------------------------------ */
/* GitHub storage                                                      */
/* ------------------------------------------------------------------ */

function ghHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "monolingo-bot",
    "x-github-api-version": "2022-11-28",
  };
}

async function readWords(env) {
  const url =
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/` +
    `${env.WORDS_PATH}?ref=${env.GITHUB_BRANCH}`;
  const getResp = await fetch(url, { headers: ghHeaders(env) });
  if (getResp.ok) {
    const file = await getResp.json();
    return { words: JSON.parse(base64Decode(file.content)), sha: file.sha };
  }
  if (getResp.status === 404) return { words: [], sha: undefined };
  throw new Error(`GitHub read error ${getResp.status}: ${await getResp.text()}`);
}

async function appendWord(entry, env) {
  const { words, sha } = await readWords(env);

  // Duplicate check (case-insensitive)
  const dup = words.find(
    (w) => w.word.toLowerCase() === entry.word.toLowerCase()
  );
  if (dup) return { duplicate: dup };

  words.push(entry);

  const putResp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.WORDS_PATH}`,
    {
      method: "PUT",
      headers: { ...ghHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({
        message: `add: ${entry.word}`,
        content: base64Encode(JSON.stringify(words, null, 2) + "\n"),
        branch: env.GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    }
  );
  if (!putResp.ok) {
    const err = new Error(
      `GitHub write error ${putResp.status}: ${await putResp.text()}`
    );
    err.status = putResp.status;
    throw err;
  }
  return { count: words.length };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function sendMessage(chatId, html, env) {
  const resp = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
    }
  );
  if (!resp.ok) {
    console.error(`Telegram sendMessage failed: ${await resp.text()}`);
  }
}

async function reportError(chatId, err, env) {
  console.error(err);
  const msg = err.userFacing
    ? escapeHtml(err.message)
    : "Something went wrong saving that word — try again in a minute.";
  await sendMessage(chatId, msg, env).catch(() => {});
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// UTF-8-safe base64 (atob/btoa alone mangle non-ASCII)
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64Decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
