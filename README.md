# Jara — your G$, put to work

Live at **[usejara.xyz](https://usejara.xyz)** · Source: [github.com/miss-yusrah/jara](https://github.com/miss-yusrah/jara)

Jara is an AI agent for everyday life, built for **GoodBuilders Season 5** (GoodDollar × Flow State, on Celo).

Jara quietly handles four everyday jobs, and **G$ drives all of them**:

- **Saves.** Claims your daily GoodDollar UBI and splits it into jars (Light, Data, Airtime, AI).
- **Pays.** Learns how often each bill comes round, tops the jar up before it's due, then pays Nigerian airtime, data or prepaid electricity on time.
- **Finds rewards.** Spots and collects G$ bonuses: streaks, first bill, weekly saver, invites, first gig.
- **Powers your AI.** The G$ you gather pays for AI helpers: research briefs, assignment help (understand and outline it, not ghost-write it), brainstorming, exam practice (WAEC/JAMB/NECO), CV and cover letter, an opportunity scout, side-hustle plans and a content writer. Each use moves G$ from your **AI jar** to the treasury on Celo, and the treasury pays for the AntSeed inference. You're only charged when an answer comes back.

The agent runs on its own schedule (`/api/cron/daily`, every few hours) and sends one quiet summary. Auto-pay also checks immediately after balance changes and every minute. You talk to it on Telegram or on the web, in English or Pidgin. Manual bills require confirmation; jars explicitly set to pay automatically use their saved amount, recipient and schedule. The assistant itself can never spend G$ or change a payment setting: it can only ask, and the server waits for your approval (see [Safety model](#safety-model)).

## How it works

1. **One-time link.** The user's face-verified GoodDollar wallet calls `IdentityV4.connectAccount(jarAddress)`. With `CLAIMER_FACTORY_ADDRESS` configured, the linked address is an immutable claim contract owned by that root wallet. New accounts have no agent key. Existing users upgrade from their profile and retain access to old wallet funds and keys (see [Safety model](#safety-model)). Connected accounts share the identity's single daily claim, so the jar wallet can claim UBI itself.
2. **Daily cron** (`/api/cron/daily`). For upgraded users, Jara pays gas to call the claim contract, which atomically forwards all G$ to the owner. Legacy users still call `UBIScheme.claim()` from their agent wallet. Jara splits the new G$ across jars by how much each still needs, gives a streak bonus every 7 days, and auto-pays any jar that has reached its target. It then sends a morning message on Telegram.
3. **Paying a bill.** One funding wallet pays the treasury on Celo: for upgraded users, the verified personal wallet through `JaraSpending` within its owner-set daily/total limits and expiry. Legacy users can still pay from the Jara-managed wallet or a direct personal-wallet allowance. A purchase is never split between both. The configured provider then delivers the bill. A confirmed failure refunds the original funding wallet.
4. **The agent brain.** An OpenAI-compatible tool-calling loop pointed at the **AntSeed** buyer proxy (`localhost:8377`), which pays per call in USDC on Base. If AntSeed isn't reachable, a built-in rule parser takes over, so the bot never goes silent.

Gas: the GoodDollar faucet is tried first, and the treasury sends CELO if the faucet doesn't cover it.

### Money and jar budgets

Jars are allocations of available G$, not additional wallets or additional money. Purchases can use only their own jar. The dashboard's explicit budget-move form changes allocations atomically without transferring tokens. Automatic allocation may distribute unassigned funds, but cannot borrow from another jar. Personal-wallet budgets are not locked savings: external spending or allowance changes can reduce them.

Upgraded users receive UBI directly in their own wallet. Legacy users still receive it in a wallet whose encrypted key Jara manages and can explicitly withdraw those funds. New keyless claims do not accrue gas debt; Jara sponsors their actual estimated gas. Spending remains delegated within an on-chain policy, so the whole application should not be described as eliminating every custody or server-compromise risk. Existing personal-wallet G$ stays there until a purchase uses its allowance. Each verified root wallet can fund only one Jara account; existing duplicate accounts require reconciliation rather than silently sharing a balance.

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

## Safety model

### Agent-wallet key custody

The app supports keyless claims through [`JaraClaimer`](contracts/src/JaraClaimer.sol), integrated in [`claimers.ts`](src/lib/claimers.ts), onboarding, the daily job, rewards and the profile UI. The owner links a deterministic, per-owner contract to GoodDollar. Anyone may trigger a claim, but its immutable owner is the only recipient. There is no operator permission, upgrade path, or private key for that contract. The owner can revoke the GoodDollar link and recover stray tokens directly, even without Jara.

- Setting `CLAIMER_FACTORY_ADDRESS` enables keyless onboarding. Preparation only computes/reads the address; deployment is sponsored after a fresh owner signature tied to the Jara account and an on-chain identity check. This prevents a public deterministic address from being used to take over another person's onboarding.
- Existing users choose **Profile → Upgrade daily claims**. Their wallet cancels the old treasury allowance, disconnects the old agent identity, and connects the new contract. Activation independently verifies those revocations, the signature, contract owner and GoodDollar addresses; pending legacy transfers block migration. Retries are safe. If interrupted after unlinking, legacy claims pause until the user completes the upgrade.
- The new claim path never decrypts an agent key. Claims and new rewards go directly to the root wallet. Reward transfers already signed before migration finish at their original destination. Claim gas is estimated by the durable transaction outbox, rather than the legacy fixed gas-top-up budget.
- After migration, old wallet balances are excluded from spending budgets. Old encrypted keys remain available for owner-signed export and withdrawal until the old wallet is unlinked and empty; an operator then deletes them (see "Retiring old wallet keys" below). Any remaining G$/CELO and old backups still carry legacy-key risk. Users should withdraw old G$, export the old key if needed to recover CELO, and stop depositing into the old address.
- Removing the factory setting stops new keyless onboarding, but never switches an upgraded user back to agent-key claims. Keep the stored contract columns and current application code when rolling back configuration. Running an older application binary against migrated accounts is unsupported.

[`JaraSpending`](contracts/src/JaraSpending.sol) replaces the direct treasury allowance for upgraded accounts. Only the owner can configure a policy; the contract enforces a total remaining budget, a UTC-calendar-day cap, expiry, a fixed treasury recipient and one-use payment IDs. The UI currently offers G$ 5,000 total, G$ 1,000 per UTC day, for 30 days. The owner may revoke through token approval or the policy. Reconfiguration does not reset spending already used that day. Refunds restore tokens, but do not restore consumed policy budget or token allowance. Purchases larger than the remaining daily cap are unavailable, including automatic bills; jars reflect the currently spendable amount rather than all personal-wallet funds.

A server attacker **can still consume the remaining authorized daily budget**, repeat on later days until the total/expiry is exhausted, and take the treasury's own funds. A UTC day cap is not a rolling 24-hour cap: two days' budgets can be spent around midnight, still bounded by the total. This is a bounded delegation, not proof that the server delivered a bill. It does not replace server-side purchase consent. Without `SPENDING_CONTRACT_ADDRESS`, upgraded users can continue claiming but cannot spend through Jara; the server never falls back to a raw treasury allowance. Existing users remain exposed to their old direct allowances until they revoke them during upgrade.

Legacy agent keys continue to use per-wallet envelope encryption in [`wallets.ts`](src/lib/wallets.ts), with AWS KMS support in [`custody.ts`](src/lib/custody.ts). Owners can export them after a fresh root-wallet signature (`POST /api/wallet/key`). Per-wallet encryption and KMS prevent a database-only leak from directly revealing keys. **The KMS credentials stored on the server can authorize decryption**, so database plus usable server credentials, or live server execution, can still expose those legacy keys. Encryption context and CloudTrail improve binding and auditability; they do not enforce user consent or prevent bulk access by authorized credentials. Local-key mode also exposes keys if its shared wrapping secret is copied. Forwarding reduces retained balances, but it is not a substitute for migrating and revoking the old identity link.

Deployment and verification: [keyless rollout runbook](docs/keyless-rollout.md). The code is not evidence that the live deployment has been migrated. Confirm factory/spending addresses and account counts through the admin custody report after deployment.

Retiring old wallet keys (no external key service needed):

A stored key is only worth protecting while its wallet can still do something. [`key-retirement.ts`](src/lib/key-retirement.ts) deletes a stored key once its wallet is not linked to any GoodDollar identity, holds no G$, and has no transaction, payment or refund in flight. A connected owner who has not upgraded always keeps theirs. Every check fails closed, and nothing runs on a schedule.

1. Owners upgrade in Profile, then withdraw any G$ left in the old wallet (and export the key first if they want the leftover CELO).
2. `GET /api/admin/treasury?custody=retire` (admin key) lists every stored key with the decision and the reason. It changes nothing.
3. `POST /api/admin/treasury` with `{"retireKeys": true}` deletes the keys the report marked. Deleting cannot be undone. Repeat as more owners upgrade.
4. When `?custody=1` reports `"wallets": 0`, no agent key remains in the database. Then replace `WALLET_ENCRYPTION_KEY` with a fresh random value, so the old secret is no longer on the server, move earlier backups off the server (they still contain the old keys and the old secret), and run `VACUUM` once so deleted keys do not linger in free pages of the database file.

Switching an existing deployment to KMS (optional; only useful while stored keys remain):

1. Back up the database.
2. Create a symmetric KMS key and an IAM user allowed only `kms:Encrypt` and `kms:Decrypt` on that key. Turn on CloudTrail and an alarm on unusual `Decrypt` volume.
3. Add the four `WALLET_KMS_*` variables to the server environment, leaving `WALLET_KEY_PROVIDER` as it is, and prove they work before any wallet depends on them:

   ```sh
   node --env-file=.env.production.local --require ./tests/register.cjs scripts/check-kms.cjs
   ```

   It wraps and unwraps a throwaway key and confirms KMS refuses to unwrap it for a different wallet. It reads no database and no wallet key.
4. Set `WALLET_KEY_PROVIDER=aws-kms`. Keep `WALLET_ENCRYPTION_KEY` for now, then restart the app.
5. Existing keys move over when first used and in the daily cron, each verified under KMS before it replaces the old row; a failure leaves the old row in place and logs `[custody] could not re-wrap wallet key`. `GET /api/admin/treasury?custody=1` (admin key) shows how many are still pending.
6. When it reports `"pending": 0`:
   - Delete `WALLET_ENCRYPTION_KEY` from the server environment.
   - Move every earlier backup off the server. A backup holding the old database and the old environment file still contains every legacy key and the secret that opens them, so leaving it beside the app undoes this step. Keep one copy offline: restoring an old backup needs the old secret.
   - Run `VACUUM` on the database once, so superseded copies of the wrapped keys do not linger in free pages of the file.
7. Never disable or schedule deletion of the KMS key while retained wallet keys exist: they cannot be opened without it. Owners who exported their key are unaffected.

### The assistant cannot spend without approval

Any tool the model can call that charges G$ or changes how money is paid (`use_ai_helper`, `set_jar`, `move_to_jar`, switching on `set_exam_prep` or `set_opportunity_scout`) does not run when the model calls it. The server validates the arguments, stores them as a pending row in `approvals`, and shows the user exactly what will happen and what it costs. Only the user's own action approves it: the Approve button (web or Telegram), which names that exact request, or a message that is nothing but a plain yes, checked by the server before any model call. What then runs is the stored request, once, at the price shown. Requests expire after 10 minutes and a newer request replaces an older one. Switching spending off (auto-pay or a paid job) applies immediately. One-off bills already worked this way (`propose_bill`). `claim_now` and `run_agent` only carry out what the user has already switched on.

### Real and simulated money never mix

`CHAIN_MODE` decides whether G$ is real; the top-up provider is real when it has live credentials (VTpass `VTPASS_ENV=live`, FalconPay `sk_live_` key). Bills run only when both sides match: real G$ with a live provider, or simulated G$ with a simulated provider (mock, or a provider sandbox). Simulated G$ with a live provider, and real G$ with a simulated provider, are refused: bills and demo top-ups are disabled and the reason is logged at startup. The same check runs again at the moment a purchase is sent, so a bill prepared or charged before a configuration change is refused or refunded rather than delivered across modes (`resolveMoneyMode` and `billPurchaseProblem` in `src/lib/env.ts`). Real G$ with no provider is a valid configuration with bills switched off. The startup log line `[jara] money mode: …` and `GET /api/admin/treasury?custody=1` report the mode a deployment is running in.

### Referral rewards count people, not accounts

A referral reward is paid once per verified GoodDollar identity (the root wallet behind the referred account), never once per Jara account. `referral_identities` holds one row per identity for the whole app, so several accounts linked to the same identity, or the same person arriving through several referral links, pay out a single time, and a referrer's own identity never counts. On Celo the referred account's wallet must still resolve on-chain to that identity when the reward is paid.

## Run it

```bash
npm install
cp .env.example .env.local   # defaults to demo mode (simulated G$ + mock top-ups)
npm run dev                  # http://localhost:3400
```

In demo mode the dashboard shows **+ G$ 5,000** and **⏭ Next day** buttons, so you can play through a week live. Demo mode cannot be combined with live bill-provider credentials; see [Safety model](#safety-model).

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

### Safety follow-up

See [the seven-finding review follow-up](docs/safety-review-closure.md) for startup/database isolation, Telegram restrictions, recurring consent renewal, referral caps and remaining owner migration requirements. Demo deployments use `data/jara-demo.db` by default and cannot carry live signing/provider credentials. A database cannot switch between demo and real funds.
