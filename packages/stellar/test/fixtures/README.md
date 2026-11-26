# Horizon fixtures

Real Stellar **testnet** payment-operation records, captured so the normalizer is
tested against the field layout Horizon actually returns rather than one we
imagined.

## Where these came from

Fetched on 2026-11-22 from

```
https://horizon-testnet.stellar.org/payments?limit=200&order=desc&join=transactions
```

| File | Operation | Transaction | Captured from |
| --- | --- | --- | --- |
| `path-payment-strict-receive.json` | `25203134380912641` | `15ec20bb28ba5fe841cfd4c2541b9fd0aac5d235fe1dac0bd0839dadf6709587` | ledger 5868062 |
| `path-payment-strict-send.json` | `25201502293344257` | `9aa9b52f7f3b1190e69b91f3f0870463720b12f8cee4b45a3ba66f19cb3c8ffe` | ledger 5867682 |

The operation fields are verbatim. Trimmed for size: the `_links` block, and the
joined transaction's XDR blobs, signatures and per-resource links. The joined
transaction's `memo*`, `ledger`, `hash` and account fields are kept.

In both records the delivered side (`amount`, `asset_*`) differs from the paid
side (`source_amount`, `source_asset_*`), which is the point: a refactor that
prefers `source_amount` or `source_asset_*` fails the tests instead of silently
settling a link for the wrong amount.

## Refund destination fixtures (issue 2.14)

These two are from the public network, not testnet, because that is where a
payment from an M-address and an account that requires a memo were found.
Fetched on 2026-11-25 from `https://horizon.stellar.org`.

| File | What it is | Where it came from |
| --- | --- | --- |
| `payment-from-muxed.json` | A `payment` operation sent from an M-address: it carries `from_muxed` and `from_muxed_id` next to `from` | operation `282025647352799237`, transaction `154e4ae7a997688609a728383d4639b9927d6cdf9298bb52df5ee5eb5ab7daa5`, ledger 65664213 |
| `account-memo-required.json` | An account whose data sets SEP-29's `config.memo_required` to `MQ==`, base64 for `1` | `/accounts/GAFK7XFZHMLSNV7OJTBO7BAIZA66X6QIBV5RMZZYXK4Q7ZSO52J5C3WQ` |

The operation's fields are verbatim, without its `_links` block. Its
`transaction` holds only the memo, ledger, hash and time of the parent
transaction, fetched separately. The account file keeps only the id and the
`data` object, which the SDK exposes as `data_attr`.
