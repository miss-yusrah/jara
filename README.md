# Jara — your G$, put to work

Live at **[usejara.xyz](https://usejara.xyz)** · Source: [github.com/miss-yusrah/jara](https://github.com/miss-yusrah/jara)

Jara is an AI agent for everyday life, built for **GoodBuilders Season 5** (GoodDollar × Flow State, on Celo).

Jara quietly handles four everyday jobs, and **G$ drives all of them**:

- **Saves.** Claims your daily GoodDollar UBI and splits it into jars (Light, Data, Airtime, AI).
- **Pays.** Learns how often each bill comes round, tops the jar up before it's due, then pays Nigerian airtime, data or prepaid electricity on time.
- **Finds rewards.** Spots and collects G$ bonuses: streaks, first bill, weekly saver, invites, first gig.
- **Powers your AI.** The G$ you gather pays for AI helpers: research briefs, assignment help (understand and outline it, not ghost-write it), brainstorming, exam practice (WAEC/JAMB/NECO), CV and cover letter, an opportunity scout, side-hustle plans and a content writer. Each use moves G$ from your **AI jar** to the treasury on Celo, and the treasury pays for the AntSeed inference. You're only charged when an answer comes back.

The agent runs on its own schedule (`/api/cron/daily`, every few hours) and sends one quiet summary. You talk to it on Telegram or on the web, in English or Pidgin. It always shows you the bill and waits for your "yes". Users never hear crypto jargon.

## How it works

1. **One-time link.** The user's face-verified GoodDollar wallet calls `IdentityV4.connectAccount(jarAddress)`. The jar address is a wallet Jara creates for that user, with its key encrypted at rest. Connected accounts share the identity's single daily claim, so the jar wallet can claim UBI itself.
2. **Daily cron** (`/api/cron/daily`). For each user, Jara calls `UBIScheme.claim()` from the jar wallet, splits the new G$ across jars by how much each still needs, gives a streak bonus every 7 days, and auto-pays any jar that has reached its target. It then sends a morning message on Telegram.
3. **Paying a bill.** G$ goes from the jar wallet to the treasury on Celo (a real G$ transaction). The bill is then bought through VTpass. If VTpass rejects it, the G$ is refunded.
4. **The agent brain.** An OpenAI-compatible tool-calling loop pointed at the **AntSeed** buyer proxy (`localhost:8377`), which pays per call in USDC on Base. If AntSeed isn't reachable, a built-in rule parser takes over, so the bot never goes silent.

Gas: the GoodDollar faucet is tried first, and the treasury sends CELO if the faucet doesn't cover it.

## Run it

```bash
npm install
cp .env.example .env.local   # defaults to demo mode (simulated G$ + mock top-ups)
npm run dev                  # http://localhost:3400
```

In demo mode the dashboard shows **+ G$ 5,000** and **⏭ Next day** buttons, so you can play through a week live.

### AntSeed
```bash
npm i -g @antseed/cli
export ANTSEED_IDENTITY_HEX=...   # your buyer key
antseed buyer start &
antseed buyer connection set --peer <peerId>
```
Then set `LLM_MODEL` to a service that peer offers.

### Telegram
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`, then register the webhook:
```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=$APP_URL/api/telegram&secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## GoodBuilders metrics
`GET /api/stats` returns users, connected users, claims, bills paid and rewards, with G$ volume for each.

## Contracts (Celo mainnet, from `@goodsdks/citizen-sdk`)
| | |
|---|---|
| G$ | `0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A` |
| Identity | `0xC361A6E67822a0EDc17D899227dd9FC50BD62F42` |
| UBIScheme | `0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1` |
| Faucet | `0x4F93Fa058b03953C851eFaA2e4FC5C34afDFAb84` |

MIT · Calbridge Digital Labs
