# Jara — your G$, put to work

Live at **[usejara.xyz](https://usejara.xyz)** · Source: [github.com/miss-yusrah/jara](https://github.com/miss-yusrah/jara)

Jara is an AI agent for everyday life, built for **GoodBuilders Season 5** (GoodDollar × Flow State, on Celo).

Jara quietly handles four everyday jobs, and **G$ drives all of them**:

- **Saves.** Claims your daily GoodDollar UBI and splits it into jars (Light, Data, Airtime, AI).
- **Pays.** Learns how often each bill comes round, tops the jar up before it's due, then pays Nigerian airtime, data or prepaid electricity on time.
- **Finds rewards.** Spots and collects G$ bonuses: streaks, first bill, weekly saver, invites, first gig.
- **Powers your AI.** The G$ you gather pays for AI helpers: research briefs, assignment help (understand and outline it, not ghost-write it), brainstorming, exam practice (WAEC/JAMB/NECO), CV and cover letter, an opportunity scout, side-hustle plans and a content writer. Each use moves G$ from your **AI jar** to the treasury on Celo, and the treasury pays for the AntSeed inference. You're only charged when an answer comes back.

The agent runs on its own schedule (`/api/cron/daily`, every few hours) and sends one quiet summary. Auto-pay also checks immediately after balance changes and every minute. You talk to it on Telegram or on the web, in English or Pidgin. Manual bills require confirmation; jars explicitly set to pay automatically use their saved amount, recipient and schedule.

## How it works

1. **One-time link.** The user's face-verified GoodDollar wallet calls `IdentityV4.connectAccount(jarAddress)`. The jar address is a wallet Jara creates for that user, with its key encrypted at rest. Connected accounts share the identity's single daily claim, so the jar wallet can claim UBI itself.
2. **Daily cron** (`/api/cron/daily`). For each user, Jara calls `UBIScheme.claim()` from the jar wallet, splits the new G$ across jars by how much each still needs, gives a streak bonus every 7 days, and auto-pays any jar that has reached its target. It then sends a morning message on Telegram.
3. **Paying a bill.** One funding wallet pays the treasury on Celo: either the Jara-managed wallet or the verified personal wallet within its approved allowance. A purchase is never split between both. The configured provider then delivers the bill. A confirmed failure refunds the original funding wallet.
4. **The agent brain.** An OpenAI-compatible tool-calling loop pointed at the **AntSeed** buyer proxy (`localhost:8377`), which pays per call in USDC on Base. If AntSeed isn't reachable, a built-in rule parser takes over, so the bot never goes silent.

Gas: the GoodDollar faucet is tried first, and the treasury sends CELO if the faucet doesn't cover it.

### Money and jar budgets

Jars are allocations of available G$, not additional wallets or additional money. Purchases can use only their own jar. The dashboard's explicit budget-move form changes allocations atomically without transferring tokens. Automatic allocation may distribute unassigned funds, but cannot borrow from another jar. Personal-wallet budgets are not locked savings: external spending or allowance changes can reduce them.

Automatic UBI claims still arrive in a wallet whose encrypted key Jara manages. Users can explicitly withdraw those funds. This is not a fully noncustodial design. Existing personal-wallet G$ stays there until a purchase uses its allowance. Each verified root wallet can fund only one Jara account; existing duplicate accounts require reconciliation rather than silently sharing a balance.

New purchases charge the quoted G$ amount only. Jara covers sponsored payment fees; it does not append an unquoted gas charge. Existing `gas_owed_wei` balances remain reserved and visible for separate reconciliation, rather than being silently forgiven or collected with new purchases.

### Payment recovery

Auto-pay uses the same durable purchase IDs in the daily agent, immediate checks, and `POST /api/cron/auto-pay`. Claims check inline; deposits, budget moves, jar settings and chat actions schedule a check with Next's `after` so the response does not wait on bill delivery. The minute sweep picks up external deposits and retries missed background work without running claims or AI jobs. Pending purchases resume their saved action/reference even across midnight or changes to jar settings. "When full" retains a maximum of one automatic purchase attempt per jar per Lagos day; cadence jars wait for their due date. Confirmed manual payments also suppress when-full auto-pay for that day. A full jar must cover the quote including the configured spread.

`scripts/deploy.sh` installs the separate minute job after a successful deployment. To install it on an existing VPS release, run `cd /opt/jara && node scripts/install-auto-pay-cron.mjs`. It preserves the daily agent cron and other schedules. The runner loads `CRON_SECRET` from the server's `.env.production.local`, uses `flock` plus a database lease to prevent overlapping sweeps, and writes a secret-free status to `data/auto-pay-status.json`. Check its `checkedAt`, `durationMs`, `busy` and `retries` fields; failures go to `data/auto-pay-cron.log`. If a check is busy, or chain/provider services are unavailable, payment can take longer than a minute. Disabling this job means removing only the crontab line marked `# jara-auto-pay`; immediate checks and the daily fallback remain active.

- `money_requests` binds a request ID to its owner, input, saved output, and final result. Clients retain IDs through retries. Bill confirmation buttons identify the exact reviewed bill. Automated bills use stable cycle IDs; daily claims and rewards use stable day/reward IDs.
- `payments` reserves the selected jar budget before charging. `chain_transactions` stores signed transaction bytes and their hash **before broadcast**. Recovery rebroadcasts those same bytes, never a newly signed charge. Receipt status and the expected G$ transfer event must confirm before a charge or refund is recorded as completed.
- Database leases serialize users and signing wallets across workers. Ledger mutations verify lease ownership inside their database transaction. Unresolved signer transactions block new transactions from that signer until reconciled.
- Bills persist their provider reference before submission. Timeouts and `not_found` responses remain pending; they are not grounds for an automatic refund or a fresh provider purchase. Refunds remain pending until the transfer is confirmed. Refunds do not restore an ERC-20 allowance, so a refunded wallet balance may require renewed permission before it can fund jar budgets again.
- AI output is saved before payment. Only a confirmed charge creates a paid AI usage/activity record. An interrupted AI stream is not charged. Cron and session refresh resume saved payments and withdrawals.

Before deploying this migration, back up the database and stop the old workers so they cannot continue using the old payment flow. Deploy all workers together against the same database. Keep the existing daily cron enabled for recovery.

Older in-flight activities without `operation_id` lack the transaction journal needed to safely infer whether a refund already happened. Provider success can be recorded, but failed/ambiguous legacy orders remain pending for receipt reconciliation. Do not delete pending payment rows, signed transaction records, or request IDs to force retries. Check the original transaction and provider reference first; a dropped transaction or a provider that never returns a definitive result can require operator intervention.

Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` to verify changes. Tests use isolated temporary databases and simulated RPC/provider failures; they do not move real funds.

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
