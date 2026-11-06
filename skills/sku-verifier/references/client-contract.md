# Client contract and operation

The service origin is required configuration. `--endpoint` takes precedence over `SKU_VERIFIER_ENDPOINT` at quote time. The receipt freezes the origin and target; execute and recover use that same origin. The CLI accepts HTTPS origins without userinfo, paths, queries, or fragments. It rejects redirects and performs no automatic retry. Node 20+ uses the platform's TLS certificate validation.

A new run directory must not exist. Its parent must exist. The CLI creates the directory with mode 0700 and atomically writes and syncs mode-0600 `receipt.json` before its first request. The receipt contains schemaVersion 1, a 32-lowercase-hex orderId, a separately generated 32-byte Base64url recoverySecret, endpoint, and target. Existing private receipts are validated before networking. The receipt is a recovery capability, not proof that payment or execution completed.

Commands, with paths resolved from the caller's working directory:

```text
node <skill-dir>/scripts/client.mjs quote <target.json> <new-run-dir> --endpoint <https-origin>
node <skill-dir>/scripts/client.mjs quote-again <run-dir>
node <skill-dir>/scripts/client.mjs execute <run-dir> --proof-stdin
node <skill-dir>/scripts/client.mjs recover <run-dir>
```

`quote` posts `{orderId,target}` to `/v1/verify` with `Authorization: Bearer <recoverySecret>`. `quote-again` explicitly reposts the identical body and bearer without a payment proof to retry creating or retrieving the original bill. It keeps the original orderId and capability and never starts research. A completed order returns its stored report. `execute` posts the identical body and bearer plus `Payment-Proof` from stdin. `recover` only GETs `/v1/orders/<orderId>` with the bearer. No capability travels in a URL. Input JSON and proof are bounded to 64 KiB. Response JSON is bounded to 16 MiB, allowing JSON escaping around the service's separate 2 MiB report and 2 MiB markdown limits. Proof reading times out after 30 seconds. Quote, quote-again, and recovery time out after 30 seconds; execution after 840 seconds, below the platform's 900-second maximum. A shorter actual gateway timeout still requires deployment verification.

The accepted responses are:

| HTTP | Body | Consumer action |
| --- | --- | --- |
| 402 | `kind: payment_required`, same orderId, amount `0.99`, currency `CNY`, goodsName, payBefore, paymentLink; matching `amtPaymentLink` header | Save `bill.json`, present authorization and hand its amtPaymentLink to the official current buyer capability. |
| 200 | `kind: report`, same orderId, report, markdown | Save the report object as `report.json` and exact markdown as `report.md`. Read status and evidence gaps. |
| 202 | `kind: running`, same orderId, retryAfterSeconds `5` | Recover this run later. No automatic polling occurs. |
| 409 | `kind: needs_review`, same orderId, reason | Keep receipt and contact the operator with orderId. The CLI exits 3. |
| 402 | `error: PAYMENT_INVALID` | Stop. No replacement order or purchase. |
| 409 | `error: ORDER_EXPIRED` or `ORDER_TARGET_MISMATCH` | Stop and preserve the original run. |
| Other errors | HTTP 400, 401, 404, 429, 503, invalid body or transport error | Exit 1. Preserve the run and inspect or recover the same order. |

A bill whose `payBefore` is at or before the client clock returns `kind: expired` and exits 1. Its metadata remains in `bill.json` with `expired: true`, and the private receipt stays intact. This outcome gives no payment authorization instruction. Report recovery remains available regardless of the original bill expiry.

Normal response summaries exit 0, including a terminal report whose execution status is `failed` or `budget_exhausted`. Those statuses are printed explicitly and never described as successful research. A report is saved atomically per file. If a local write is interrupted, recover the same order to restore both files. A local receipt lost before report delivery cannot be replaced with a new capability. Retention and any refund or manual resolution policy are supplied by the service operator, not guaranteed by this client.

If quoting failed after the order was recorded but before its bill was created, GET recovery may return 503. An explicit `quote-again` retries that original bill creation with the same immutable identity. No command sends an automatic retry.

`recover` is read-only at the service. It cannot restart work that died after payment. Stale or uncertain executions need operator review. Do not interpret an absent report as permission to charge or run again. The service stores reports before delivering them, so a successful investigation with a lost response can be recovered without a fresh payment proof.

For local automated HTTP fixtures only, set `SKU_VERIFIER_ALLOW_LOCAL_HTTP=1` and use an explicit `http://127.0.0.1:<port>` or `http://[::1]:<port>` origin. This escape hatch does not allow remote cleartext HTTP and must not be used for real payments. No wallet or payment SDK is bundled with the client. Do not import commands from an old payment protocol.

Target limits match the service. Brand and productName each contain 1 to 60 characters; version and packageForm are optional nonempty strings of at most 120 characters; netQuantity has a positive finite value and a supported unit of at most 16 characters; officialDomains contains at most 32 explicit domain names.
