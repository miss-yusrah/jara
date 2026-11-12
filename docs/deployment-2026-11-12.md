# Production deployment — November 12, 2026

The application was activated at **11:53:21 UTC (12:53:21 WAT)** at [usejara.xyz](https://usejara.xyz). Build ID: `5r1RNjGgBM5ivbQUBQQyJ`. This release includes keyless claim onboarding/migration, bounded spending, server-side assistant approvals, money-mode isolation and identity-based referral rewards.

## Celo mainnet contracts

Chain ID: **42220**. Both deployment receipts succeeded. Sourcify reported **exact_match** for both sources and the deployment script checked runtime bytecode and immutable constructor addresses.

| Contract | Address | Deployment receipt |
| --- | --- | --- |
| JaraClaimerFactory | `0x62A5700C5b6fb6Aedea0dD84b79D5722B7727a3a` | [Transaction, block 82582482](https://celoscan.io/tx/0xfe54565efd0be2faaedf538743b602249e4f1e0329b486c117832ef2211af47f) |
| JaraSpending | `0x98720954737585183F01a5f6eaCDD8442e9c780F` | [Transaction, block 82582487](https://celoscan.io/tx/0xdc36388fcd2b028be7914b25ddd034853a747592554330b4c45e54a3109c5646) |

The spending operator and recipient are `0xcDEbe3A2442cfDa4Df27C675768e55702b1d0a7B`. Actual deployment fees totalled **0.229449036167111736 CELO**, calculated from receipt gas used and effective gas price. Production configuration contains both verified contract addresses. The durable deployment journal is `/opt/jara/output/custody-deployment.json`; preserve it to avoid duplicate broadcasts.

## Production configuration and migration status

The authenticated admin report after activation returned:

```json
{
  "keyless": {
    "accounts": 26,
    "active": 0,
    "awaiting_upgrade": 5,
    "retained_keys": 26
  },
  "custody": {
    "provider": "local",
    "wallets": 26,
    "byProtection": { "legacy": 26 },
    "pending": 26
  },
  "money": {
    "mode": "live",
    "problem": null,
    "chain": "celo",
    "provider": "falconpay",
    "billsLive": true
  }
}
```

Demo bills are disabled, FalconPay uses a live credential, and VTpass is inactive. No credential values were included in deployment output or this record.

New accounts use keyless onboarding. The five existing connected users must approve **Profile → Upgrade daily claims** using their own wallets. No owner was impersonated or migrated by the deployer. Legacy encryption remains local, not AWS KMS, and old keys are retained for balance recovery. The server compromise exposure remains for unmigrated accounts and old balances. Upgraded users separately grant spending policies; a compromised server can consume those authorized budgets and access the treasury's own funds.

One pre-existing legacy-wallet claim from November 8 was still pending before deployment. Its journal entry was preserved, not deleted or replaced. It may block that account's upgrade until settled. It was not a pending treasury transaction. No live migration or claim was initiated by the deployment checks.

## Verification

- All **112 application tests** and lint passed. The production build succeeded using `npm run build -- --webpack`.
- Before release, 16 local Solidity tests and the combined Celo fork flow with two public verified roots passed. These are tests, not an independent audit.
- The first cutover exposed a SQLite escape-clause error in the historical referral backfill. The previous compiled app was restored while the query was corrected to `GLOB 'referral-u_*'`. A populated-history regression test and migration against a private production snapshot passed before the corrected release was activated.
- A temporary unconnected production account was created through HTTP. Its database key field was the `keyless` sentinel, with no encrypted private key. The account reported live money mode and both contract settings. Demo deposits and legacy key export returned 404; legacy deposits returned 400. Only this temporary account and its jars were removed afterward; the final account count remained 26.
- Public HTTPS home, `/app`, and `/api/session` returned 200. Unauthenticated admin access returned 401. Authenticated custody checks returned 200 with the configuration above.
- PM2 reported the app online. Both Jara cron entries were restored. At 11:54:02 UTC, the auto-pay worker recorded a completed run, two processed users, no busy lock and no payments.
- No interactive production browser-wallet walkthrough or production owner-approved migration has been completed.

## Backup and operational recovery

The protected backup directory is `/opt/jara-backups/20261112T112711Z`. It contains a coherent pre-cutover SQLite backup, previous source/configuration, previous build and dependencies, saved crontab, and activation metadata. The new staging directory is `/opt/jara-release-20261112T112711Z`.

The database changes are additive. Do not overwrite the live database with the snapshot after new activity, or discard payment/chain journals. After any owner activates keyless claims, do not restore a binary that ignores `claimer_active`. See the [rollout runbook](keyless-rollout.md) for policy revocation and recovery behavior.

The initial release was deployed from the working tree. Its remediation source is now recorded in commit `d3222d2dab8d07e20681d06f31c812ba7f6bf8b4`. The reviewer update is prepared in [goodbuilders-update.md](goodbuilders-update.md) and has not been sent externally.
