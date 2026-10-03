# Recorded Anchor Fixtures

This directory contains unauthenticated recorded public fixtures (SEP-1 `stellar.toml`, SEP-6 `/info`, and unauthenticated SEP-12 responses) for testing anchor compatibility offline in CI without hitting live external endpoints.

To refresh or record fixtures for a new anchor domain, run from the project root:

```bash
node scripts/record-anchor-fixtures.mjs <home_domain>
```

For example:
```bash
node scripts/record-anchor-fixtures.mjs cowrie.exchange
node scripts/record-anchor-fixtures.mjs testanchor.stellar.org
```
