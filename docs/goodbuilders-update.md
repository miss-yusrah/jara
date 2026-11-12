Hi GoodBuilders team,

Thank you for the review. We have implemented and deployed fixes covering the seven findings and the earlier custody concerns. Jara is live at [usejara.xyz](https://usejara.xyz). Please re-review [the remediation revision](https://github.com/miss-yusrah/jara/commit/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17), which supersedes the reviewed revision `807ab2b919a415ab271655cd932bcf92de389baa`.

Existing-user wallet migration is still pending owner approval. The upgrade is implemented and available, but we cannot sign the required wallet transactions on users’ behalf. Details and remaining exposure are below.

**Agent-wallet custody**

New production accounts use immutable, per-owner claim contracts and have no agent private key. Claims forward G$ atomically to the owner’s wallet; Jara cannot change the recipient. A separate spending contract enforces the owner’s total budget, UTC-day limit and expiry, with a fixed recipient and replay protection.

Existing users upgrade from Profile. Activation requires a fresh, account-bound owner signature and verifies the new identity link, revocation of the old agent link, and removal of the old direct treasury allowance. Owners can export their legacy key after a fresh signature to recover old balances. Real-money use cannot fall back to the fixed development encryption key, regardless of `NODE_ENV`.

Both contracts are deployed on Celo and have Sourcify exact-match source verification:

- Claimer factory: `0x62A5700C5b6fb6Aedea0dD84b79D5722B7727a3a`
- Spending contract: `0x98720954737585183F01a5f6eaCDD8442e9c780F`

At the November 12 safety deployment, five connected users awaited upgrade and none had activated it. The 26 retained wallet keys use per-wallet envelope encryption under a server-held secret; AWS KMS is **not** enabled. Existing balances, retained keys and unrevoked permissions remain exposed until owners migrate and recover their funds. A compromised server can also consume an upgraded user’s authorized spending budget and access the treasury’s own funds. We are not claiming those residual risks have disappeared.

Code: [claim contracts](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/contracts/src/JaraClaimer.sol), [spending policy](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/contracts/src/JaraSpending.sol), [migration checks](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/claimers.ts), [legacy key export](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/app/api/wallet/key/route.ts), [key-provider checks](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/custody.ts).

**J-01 — Demo/live separation**

Startup rejects incompatible chain/provider modes and demo deployments containing live provider or treasury/reporting signing credentials. Separate default databases and a persistent mode marker prevent switching a database between simulated and real funds. Purchases check the mode again before provider delivery.

Production was verified as **real Celo G$ + live FalconPay**, with `DEMO_BILLS=false`; VTpass is inactive. Demo deposits are blocked.

Code: [configuration and startup validation](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/env.ts), [database isolation](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/db.ts), [purchase boundary](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/bills.ts).

**J-02 — Durable payment recovery**

Orders, quotes and provider references are persisted before charging. Signed transaction bytes and hashes are persisted before broadcast. Recovery uses the same operation ID and provider reference after timeouts or restarts. Unsettled provider responses, HTTP errors without a final outcome, and responses for a different reference remain pending. Unknown outcomes block conflicting automatic purchases; they do not trigger another purchase or a speculative refund. The production snapshot contained no unresolved legacy bill orders lacking operation journals.

Code: [orders and settlement](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/bills.ts), [transaction journal](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/chain-outbox.ts), [automatic-payment recovery](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/auto-pay.ts).

**J-03 — Refund and reward accuracy**

Payments require a successful receipt and the expected token transfer. A successful receipt with unexpected transfer logs remains pending for reconciliation; only an actual reverted receipt is treated as a failed transaction. Refund obligations remain pending until confirmed and are retried with the original ID. Reward retries reuse the original transaction, so a lost confirmation cannot authorize a second payout.

Code: [receipt verification](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/chain-outbox.ts), [charges and refunds](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/spend.ts), [reward payouts](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/rewards.ts).

**J-04 — Single-use, bill-bound confirmations**

Confirmations identify the exact request and include expiry and the displayed quote. Database locks and durable request records prevent duplicate execution. Old buttons cannot approve a newer bill; retries return or resume the original order.

Code: [confirmation execution](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/agent/index.ts), [immutable requests](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/money-request.ts), [database locks](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/money-lock.ts).

**J-05 / earlier JAR-06 — Enforced approval for AI spending**

Paid AI helpers, payment-setting changes, budget moves and enabling paid scheduled jobs create stored requests. Explicit user approval executes the stored arguments at the shown price. We also paused pre-existing auto-pay and paid-job settings for renewed consent, retaining their details and already-submitted payment recovery records.

Code: [approval records](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/agent/approvals.ts), [tool authorization](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/agent/index.ts), [one-time consent reset](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/db.ts).

**J-06 — Telegram sender authorization**

Messages and callbacks require a private chat and a matching, non-bot sender. Group linking and group financial commands are rejected before account actions. Scheduled notifications cannot send account data to group IDs. Web sign-in and Telegram linking also consume single-use links atomically, preventing concurrent replay. The migration disconnects any legacy group links and rotates affected session/link credentials; none were present in the production snapshot.

Code: [webhook authorization](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/app/api/telegram/route.ts), [outbound restrictions](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/telegram.ts).

**J-07 / earlier JAR-05 — Identity-based referrals and treasury caps**

Referral rewards count each verified GoodDollar root identity once across the app, exclude self-referrals, and include historical rewards. Atomic reservations enforce a **G$10,000 lifetime referral budget** and **G$2,000 UTC-day limit for new reservations** across all referrers. Unknown payouts retain their reservation through retries and restarts. These caps cover referrals, not every treasury expense.

Code: [identity checks and budget reservations](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/rewards.ts), [historical accounting](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/src/lib/db.ts).

**Validation and remaining work**

- 122 application tests, typecheck, lint and the production build passed.
- All 16 local Solidity tests passed again; earlier contract checks included the combined migration/claim/spending flow on a Celo fork with two verified identities.
- Live checks covered keyless signup, blocked demo deposits, Telegram group/foreign-sender rejection, public endpoints and admin access control. Migration was tested against a private production database snapshot before activation.
- Existing owners still need to approve their wallet migration and recover old balances. One previously recorded legacy claim is still pending and may block the affected account’s upgrade until reconciled; its original transaction journal has been preserved. We have not completed an independent contract audit or a production owner-migration walkthrough, and do not present tests or source verification as substitutes for that review.

[Detailed deployment evidence](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/docs/safety-review-closure.md) and [contract deployment receipts and migration runbook](https://github.com/miss-yusrah/jara/blob/faf2f95474aa7a39e1d1b8cedf86fd6d82618c17/docs/keyless-rollout.md) are included in the repository. Please let us know what further evidence you need for re-review.

Thank you,

The Jara team
