# Pre-reply safety recheck — November 12, 2026

This second pass reviewed the deployed revision `52802f895146f272952d2113185f50166eebfb3f`, traced authorization and payment recovery, and compared production files against the release manifest. It found additional cases beyond the earlier regression suite; the reviewer reply must include the corrective revision `faf2f95474aa7a39e1d1b8cedf86fd6d82618c17`.

## Additional fixes

1. **Ambiguous provider outcomes:** FalconPay's `settled: false` now overrides apparently terminal status words on both submission and status lookup. A response naming another reference remains pending. HTTP errors after submission, including 503, no longer authorize a refund by themselves. A final provider outcome is required. Errors in catalog/quote preparation before `/bills/pay` is sent remain safe failures.
2. **Unexpected transfer receipts:** A successful EVM receipt without the expected G$ transfer is no longer classified as a reverted transaction. Its reservation and signing queue remain pending for reconciliation; it cannot cause a false “nothing was spent” message or authorize another charge. Only an actual reverted receipt is classified as reverted.
3. **One-time sign-in links:** Web sign-in and Telegram linking now consume their bearer link within one database write transaction. Concurrent requests cannot both accept the same link. The consumed state persists across restart.

Four targeted assertions failed against the preceding implementation and passed after the payment fixes. The link test launches five simultaneous consumes, verifies one succeeds, and verifies replay is rejected after reopening the database.

## Read-only production checks

- All 116 runtime/build inputs matched the pushed release manifest before the additional changes.
- Real Celo funds and live FalconPay remained configured; referral limits were G$10,000 lifetime and G$2,000 per UTC day in new reservations.
- Zero unresolved payment charges/refunds, zero unresolved bill activities, zero group links, and zero enabled auto-pay or paid scheduled-job settings.
- Zero transactions marked reverted, so there were no historical rows requiring correction for the newly discovered receipt-classification issue.
- One pending chain transaction remains: the previously recorded legacy daily claim. Its journal was preserved. It may block the affected owner's migration until reconciled; no replacement transaction or new transfer was broadcast by this review.
- Both historically refunded orders have refund hashes and saved failures from FalconPay's service-catalog step, before any purchase submission. The provider returned `not_found` for their references, consistent with that saved pre-submission failure. A missing provider record alone would not have been treated as proof of failure.
- Five connected users still await owner-approved keyless migration. All 26 retained keys are wrapped under the local server-held secret; KMS is not enabled. Key rewrapping completion does not mean owner migration is complete.

## Validation and limits

The corrected source passed **122 application tests**, typecheck and lint. All **16 local Solidity tests** passed again; contracts were unchanged. The earlier two-identity Celo fork result remains historical evidence, not a newly performed production migration.

No live purchase, token transfer, wallet migration or reviewer message was initiated by this recheck. This is a further code and operational review with targeted failure injection, not an independent audit or a guarantee that no other defects exist. Final activation is recorded in production's `output/release.json` with its commit, build and file manifest.
