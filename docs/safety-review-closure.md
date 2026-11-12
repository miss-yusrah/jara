# Safety review follow-up — November 12, 2026

This follows the seven findings against revision `807ab2b919a415ab271655cd932bcf92de389baa`. The fixes were deployed from the current working tree to production on November 12, 2026; the deployment evidence is below. Passing tests does not replace an independent security audit.

| Finding | Implementation and limits |
| --- | --- |
| J-01 | Startup rejects mixed money modes and demo deployments containing live provider or treasury/reporting signing credentials. Mock and Celo use different default database files. A persistent database mode marker rejects switches in either direction without clearing balances or journals. Unmarked populated databases require provenance review. Purchase boundaries still check the provider before delivery. |
| J-02 | Purchase intent, quote and provider reference persist before charging; signed chain bytes persist before broadcast. Provider timeouts are reconciled using the original reference. Unknown provider outcomes remain pending rather than causing another purchase or speculative refund. Legacy orders without sufficient journals require receipt reconciliation. |
| J-03 | Receipt status and expected token transfer are checked. Refund obligations survive failure, and rewards reuse the same durable transaction ID. An ambiguous result is not reported as completed or released for another payout. |
| J-04 | Confirmations carry request IDs and expiry; execution uses database locks and immutable request data. Duplicate confirmations reuse the saved result; stale buttons cannot approve a newer bill. |
| J-05 | Paid helper calls and recurring-payment changes require explicit stored approval. The follow-up migration pauses all pre-existing auto-pay, exam and scout settings once, retaining their details and any submitted-payment recovery records. Users explicitly enable them again. |
| J-06 | Telegram messages and callbacks require a private chat, a positive numeric chat ID, and the matching non-bot sender. Group linking and financial commands are ignored before account lookup or mutation. Scheduled outbound messages refuse group IDs. Previously linked groups are disconnected and their account session/link secrets rotated. |
| J-07 | Referrals are deduplicated by verified root identity, with self-referrals excluded. A single atomic budget ledger covers all referrers. The default lifetime campaign limit is G$10,000 and UTC-day limit for new reservations is G$2,000, configurable through `REFERRAL_CAMPAIGN_BUDGET_GD` and `REFERRAL_DAILY_BUDGET_GD`. Historical paid and journaled transfers count toward the limits. Uncertain reservations never expire or release automatically. |

The referral cap covers referral rewards, not all treasury expenses. Setting either cap to zero stops new reservations while existing obligations can recover. Lowering a cap does not cancel already reserved payouts; increasing a cap is an operator decision. A UTC-day boundary can permit two daily budgets close together, bounded by the lifetime total. Delayed payouts retain their original reservation date; the daily limit governs new commitments, not the mining date of an already reserved transfer. Historical failed reservations remain counted conservatively until an operator reconciles them. The admin custody report includes current budget totals.

## Custody boundaries

Any local key provider handling real Celo funds requires a valid 64-hex encryption secret regardless of `NODE_ENV`. The fixed development key is allowed only for simulated, non-production use. The production legacy secret was already valid; this change closes the non-production live-money fallback.

New production accounts have no agent private key. Existing owners still must approve the keyless upgrade and revoke their old identity link and treasury allowance. Neither the application nor the deployer can supply those owner signatures. Legacy encrypted keys remain available for balance recovery. KMS was not configured by this follow-up, and old ciphertext, balances and unrevoked allowances remain exposure until owner migration/recovery. On-chain spending policies bound upgraded accounts; a compromised server can still consume granted budgets and access its treasury funds.

## Verification

- 118 application tests passed, including six added tests covering group/foreign-sender Telegram requests, outbound group data protection, unsafe startup configuration, database mode switches in both directions, one-time recurring-consent reset and revocation of group credentials, and simultaneous referral reservations/history/retry.
- Typecheck and lint passed.
- Production staging uses a private SQLite snapshot to test the migration before live activation. No test sends a real bill purchase, Telegram message or token transfer.
- Existing transaction and payment journals are preserved; unresolved legacy payments must not be automatically refunded without evidence of the original transfers.

## Deployment evidence

Activated at **12:10:05 UTC (13:10:05 WAT)** on [usejara.xyz](https://usejara.xyz), build **`WkuSrVIZgbVZgtOSNPRQp`**. The production Webpack build passed. Backup: `/opt/jara-backups/20261112T120318Z` (SQLite snapshot, prior source/configuration/build, crontab and activation metadata). No new contract deployment or token transfer was needed for this follow-up.

The private production snapshot contained 26 accounts, two enabled auto-pay settings, one enabled paid-job configuration, zero group links and zero unresolved legacy bill orders without operation journals. Snapshot migration passed before activation. Live checks confirmed all existing recurring settings were paused, and group/foreign-sender webhook requests changed no account, message or approval counts. No Telegram messages were sent by these checks.

The authenticated admin report confirmed live Celo + live FalconPay, referral lifetime/day reservation limits of G$10,000/G$2,000, and zero currently reserved referral G$. The app was online under PM2 and both cron entries were restored. Public home, app and session endpoints returned 200; unauthenticated admin access returned 401.

There were **zero active migrated accounts and five connected accounts awaiting upgrade**. All 26 retained wallet keys now use per-wallet envelopes under the **local** provider (rewrapping `pending: 0`), which does not remove server-held-key exposure or mean users have upgraded. No owner signatures were supplied on users' behalf. Old wallet balances, permissions and backups remain subject to the custody boundaries above.

The original keyless deployment and contract receipts are documented in [deployment-2026-11-12.md](deployment-2026-11-12.md). That rollout preceded the source commit. The remediation source is now recorded in commit `d3222d2dab8d07e20681d06f31c812ba7f6bf8b4`; see [the reviewer reply](goodbuilders-update.md) for permanent code links. No reviewer message has been sent.
