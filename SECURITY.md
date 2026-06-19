# Security Policy

Stellar Checkout handles payment flows, so we take security reports seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, report privately using one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  (the **Security** tab → **Report a vulnerability**), or
- email the maintainer at **adenijiayomideay@gmail.com**.

Please include:

- a description of the vulnerability and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected component(s) and version/commit,
- any suggested remediation.

## What to expect

- We aim to acknowledge a report within **5 business days**.
- We will keep you updated on progress and let you know when a fix is released.
- We ask that you give us a reasonable window to remediate before any public
  disclosure.

## Scope notes

This project is currently **pre-production**. Several things are intentionally not
production-ready and are documented as such in the [README](./README.md):

- **No authentication** — a single hard-coded demo seller, no API keys or login.
- **The off-ramp is a mock** — `MockAnchorOffRamp` moves no money.
- **USDC issuers in `.env.example` are placeholders** that must be verified per network.

Reports about these *known, documented* limitations are appreciated but may be
closed as "by design (pre-production)". Reports about unexpected behaviour — for
example a way to bypass the payment-matching or idempotency guards, forge a webhook
signature, or cause incorrect money math — are exactly what we want to hear about.
