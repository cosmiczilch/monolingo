# Monolingo

A Telegram bot for collaboratively collecting fancy words. Send it a word (or a
sentence containing one) and it uses Claude to generate a definition, synonyms,
and example sentences, then commits the entry to `words.json` in this repo.

**Stack:** Cloudflare Worker (webhook) · Claude Haiku (enrichment) · GitHub (`words.json` storage)

## Setup

You already have Cloudflare, Anthropic, and GitHub accounts, so this is ~15 minutes.

### 1. Create the Telegram bot

1. In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Pick a display name (e.g. "Monolingo") and a username (ours is `monol1ngo_bot`).
3. Copy the **bot token** it gives you.
4. Also run `/setprivacy` → select your bot → **Disable**. (Required for the
   bot to see non-command messages in a group chat.)

### 2. Push this project to GitHub

```bash
cd ~/projects/monolingo
git init && git add -A && git commit -m "initial monolingo bot"
gh repo create monolingo --private --source=. --push   # or create via github.com and push
```

### 3. Create a GitHub token for the bot

github.com → Settings → Developer settings → **Fine-grained personal access tokens** → Generate:

- Repository access: **Only select repositories** → `monolingo`
- Permissions: **Contents → Read and write**

Copy the token.

### 4. Configure and deploy the Worker

Edit `wrangler.toml`: set `GITHUB_REPO` to `your-username/monolingo`.

```bash
npm install
npx wrangler login                    # first time only
npx wrangler secret put TELEGRAM_BOT_TOKEN      # from step 1
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET # invent one: openssl rand -hex 16
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GITHUB_TOKEN            # from step 3
npm run deploy
```

Note the deployed URL, e.g. `https://monolingo-bot.<your-subdomain>.workers.dev`.

### 5. Point Telegram at the Worker

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://monolingo-bot.<your-subdomain>.workers.dev" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET value>"
```

### 6. Allowlist yourselves

1. Message the bot anything. It replies with your Telegram user ID.
2. Put it in `ALLOWED_USER_IDS` in `wrangler.toml` (comma-separated for both of
   you, e.g. `"12345678,87654321"`), then `npm run deploy` again.
3. Have your friend do the same to get their ID.

### 7. (Optional) Shared group

Create a group with your friend, add the bot. In groups the bot only reacts to
messages starting with `+` (e.g. `+perspicacious`) or `/add perspicacious`, so
normal chat is ignored. In DMs, any message is treated as a word.

## Usage

| You send | Bot does |
|---|---|
| `perspicacious` | Adds it with definition, synonyms, examples |
| `She gave a perspicacious answer` | Extracts the word; uses your sentence as an example |
| `+word` or `/add word` (in groups) | Same as above |
| `/help` | Shows usage |

Duplicates are detected case-insensitively and reported with who added them and when.

## Data format

`words.json` is an array of:

```json
{
  "word": "perspicacious",
  "definition": "having keen insight or discernment",
  "synonyms": ["astute", "shrewd"],
  "examples": ["Her perspicacious analysis impressed everyone."],
  "added_by": "Avi",
  "added_on": "2026-08-12"
}
```

The raw file is publicly fetchable (if the repo is public) at
`https://raw.githubusercontent.com/<user>/monolingo/main/words.json` — this is
the API a future flashcard app can read directly. If the repo is private, the
app will need a read-only token.

## Flashcard PWA

The same Worker serves a flashcard trainer at the root URL
(`https://monolingo-bot.<subdomain>.workers.dev`). It fetches the live word
list via `GET /api/words?key=<APP_KEY>` and schedules reviews with an SM-2
spaced-repetition algorithm. Review progress is stored per device
(localStorage) — the shared list stays clean.

Setup: `npx wrangler secret put APP_KEY` (invent a team key, share it with
friends), deploy, then open the URL on your phone, enter the key once, and
add to home screen (Safari: Share → Add to Home Screen; Chrome: Install).
Works offline using the last-synced list.

## Costs

Effectively zero at two-person scale: Cloudflare Workers free tier (100k
req/day), Claude Haiku (~fractions of a cent per word), GitHub free.
