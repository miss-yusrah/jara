# GoodBuilders review update — draft for publication

Status: deployed to [usejara.xyz](https://usejara.xyz) on November 12, 2026, with both contracts source-verified on Celo. Existing-user migration is incomplete: five connected users still need to approve the upgrade from Profile. Source links below are relative to this repository; publish them at the commit containing these changes. The [deployment record](deployment-2026-11-12.md) contains addresses, transaction receipts and live checks.

## 1. Agent-wallet custody

We have integrated immutable per-owner claim contracts into onboarding, migration, daily claims and rewards. New keyless accounts have no agent private key. Claims are sent atomically to the owner's wallet; a server operator cannot choose another recipient. The owner can revoke the identity link and interact with the contract without Jara.

Existing users upgrade from their profile. The server requires a fresh owner signature bound to the Jara account and independently verifies the new identity link, old agent revocation, removal of the old direct treasury allowance, and contract owner/configuration. Old keys remain exportable after an owner signature for recovery of existing balances. Those balances and retained keys are still legacy exposure until users recover their funds.

We also added an immutable spending-policy contract. Upgraded users approve that contract separately; it enforces total and daily limits, expiry, a fixed recipient and replay prevention. A compromised server can still consume the remaining approved budget, and the treasury's own funds remain exposed to its server key. This bounds that authority rather than claiming to eliminate it.

Code: [claim contract](../contracts/src/JaraClaimer.sol), [spending contract](../contracts/src/JaraSpending.sol), [activation and claim execution](../src/lib/claimers.ts), [onboarding](../src/app/api/onboard/route.ts), [daily job](../src/lib/daily.ts), [legacy key export](../src/app/api/wallet/key/route.ts).

The combined contract flow passed on a local Celo mainnet fork at block 82581035 with two independently selected public verified identities. The factory and spending contract are now deployed on Celo, with Sourcify exact-match verification. At activation, zero existing users had migrated and five connected users awaited upgrade. No production owner-migration receipt is claimed. At the safety follow-up, the database retained 26 wallet keys rewrapped into per-wallet envelopes under the local server-held secret; AWS KMS is not enabled in production. These legacy keys and allowances remain exposed to a server compromise until their owners revoke the old permissions and recover balances. New signups use the keyless path. The upgrade and recovery paths are live, but this deployment alone does not complete remediation for existing users.

## 2. JAR-06 — server-side approval

The assistant's spending and payment-setting tools create stored approval requests. Explicit user confirmation executes the stored arguments once, with expiry and replay protection. This covers paid AI help, jar settings, allocation changes, and enabling paid scheduled jobs. The safety follow-up also pauses existing recurring settings once so users explicitly enable them again; already submitted payments remain recoverable. Disabling them remains immediate.

New purchases charge only the reviewed amount; old gas debt is reserved separately, not silently appended. Keyless claims are sponsored without accruing new gas debt.

Code: [approval records](../src/lib/agent/approvals.ts), [tool dispatch](../src/lib/agent/index.ts), [payment boundary](../src/lib/spend.ts), [review regression tests](../tests/review-findings.test.cjs).

## 3. J-01 — demo/live isolation

Bill payments require both money sides to match: simulated G$ with a simulated provider, or real G$ with a live provider. Mixed configurations fail startup, and purchase boundaries disable bills and demo top-ups. Separate default database files and a persistent mode marker prevent demo/live database reuse. The purchase boundary checks again before provider delivery; a changed configuration cannot silently spend across modes. This includes VTpass and FalconPay.

Code: [configuration validation](../src/lib/env.ts), [purchase boundary](../src/lib/bills.ts), [demo top-up](../src/app/api/demo/deposit/route.ts).

**Production verified November 12:** the authenticated admin report returned `mode: live`, `problem: null`, `chain: celo`, `provider: falconpay`, and `billsLive: true`. `DEMO_BILLS=false`; the active FalconPay credential is live. VTpass is inactive. A live smoke check confirmed that demo deposits are rejected.

## 4. JAR-05 — unique-identity referrals

Referral rewards are reserved once per verified GoodDollar root identity across the application. Multiple Jara accounts for one identity do not create extra rewards, self-referrals are excluded, and previously paid per-account rewards count against their identity. The verification uses the active claim contract for migrated accounts.

Code: [referral rewards](../src/lib/rewards.ts), [identity deduplication storage/migration](../src/lib/db.ts), [regression tests](../tests/review-findings.test.cjs).

## Additional seven-finding review

The [safety follow-up](safety-review-closure.md) covers the separate J-01–J-07 report, including durable payment recovery, receipt verification, confirmation replay protection, Telegram private-chat/sender enforcement, referral treasury caps and live-money secret requirements. The follow-up was activated at 12:10:05 UTC on November 12; its deployment section records the live checks and remaining migration requirements.

## Evidence and remaining work

All 118 application tests, typecheck, lint and the production Webpack build passed for the safety follow-up. Production HTTP checks verified keyless signup and deposit safeguards; public home, app and session endpoints returned 200, and unauthenticated admin access returned 401. Scheduled jobs were restored and the minute worker reported a successful run. See the [deployment record](deployment-2026-11-12.md) and [rollout runbook](keyless-rollout.md). Before the November 16 update, refresh the remaining-user count and attach an owner-approved migration receipt if available. Five connected users still needed to revoke their legacy agent and allowance at deployment; old balance recovery remains available. No independent contract audit or interactive production wallet walkthrough has been completed.
