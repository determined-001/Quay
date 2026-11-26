# Refunding a buyer: a guide for merchants

When a customer overpays, cancels an order, or requests a return, you can refund
them directly from your Quay dashboard or through the API. This guide explains how
refunds work, what your wallet is asked to sign, and how to resolve issues if a
buyer's account cannot receive the refund.

> A refund here is you paying your buyer back. An anchor refund is the anchor returning a failed cash-out to you.

If you are looking for information on cashing out your sales to your local bank account
or handling a failed cash-out, see [Cashing out a payment: a guide for merchants](MERCHANT-CASH-OUT.md).

## Why your wallet signs

Quay is non-custodial: it never holds merchant funds and never stores your private
wallet keys. When you refund a customer, USDC moves directly out of your Stellar wallet
into the customer's wallet.

To protect you:
- **The server prepares the transaction:** Quay checks how much is still refundable, runs
  preflight checks on the buyer's destination account, atomically reserves the refund
  amount so you cannot accidentally double-refund, and sets a 300-second expiration timebound.
- **Your wallet authorizes the transfer:** Only your wallet (such as [Freighter](https://www.freighter.app/))
  holds the private key needed to sign the transaction. Quay cannot move funds on your behalf.
- **The server validates the signed transaction:** Before relaying the transaction to
  the Stellar network, Quay verifies that the destination, amount, asset, memo, and
  unsigned transaction hash match the prepared refund exactly.

## How a seller refunds

```
 1. Select payment     -> Choose which payment on the link to refund
 2. Preflight check    -> Quay checks if the buyer's account can receive USDC
 3. Confirm amount     -> Enter the full or partial refund amount (and memo if needed)
 4. Sign with wallet   -> Review and approve the transaction in Freighter
 5. Settle on ledger   -> The refund confirms on-chain and updates your dashboard
```

### 1. Select the payment to refund

In your Quay dashboard, open the payment link. Under the link timeline and payments
table, locate the payment you want to refund and click **Refund**. A link can have
multiple payments (for example, split payments or top-ups), so refunds are initiated
against a specific payment operation.

### 2. Destination preflight

Before prompting your wallet, Quay automatically inspects the buyer's address on the
Stellar ledger. It ensures:
- The buyer's account exists and is funded on Stellar.
- The account holds an active, authorized trustline for the link's asset (e.g. USDC).
- The account has enough trustline headroom to receive the refund amount.
- Whether the destination requires a deposit memo (SEP-29).

If the preflight check succeeds, the refund dialog displays the recipient address and
allows you to enter the refund amount.

### 3. Enter the amount

You can issue a full refund or a partial refund:
- **Full refund:** Returns the entire payment amount.
- **Partial refund:** Useful when returning overpayment (`overpaidAmount`) or partial
  order cancellations. You can issue multiple partial refunds against a single payment
  as long as the cumulative total does not exceed the paid amount.

### 4. Review and sign with your wallet

When you click **Prepare refund**, Quay builds the unsigned transaction and prompts
your browser wallet extension (e.g. Freighter). The prompt shows:
- **Operation:** Payment
- **Amount & Asset:** e.g., `0.5 USDC`
- **Destination:** The buyer's address (or muxed address if they paid from one)
- **Memo:** `refund <reference>` (or the buyer's specific deposit memo)

Click **Sign** in your wallet.

### 5. Confirmation

Quay receives the signed transaction, verifies it, and submits it to Horizon. The refund
status changes to `submitted` with a Stellar transaction hash. Once the ledger watcher
sees the transaction included in a ledger, the refund is marked `confirmed`.

---

## Why a memo is sometimes required

When a customer pays you from a cryptocurrency exchange (such as Binance, Coinbase, or Kraken)
or a custodial wallet service, all users at that exchange share one or more pooled deposit
accounts.

The exchange uses a **deposit memo** (a unique number or text string) to credit the
specific customer's account.
- If a customer pays from an exchange account that configured **SEP-29 memo requirements**
  (`config.memo_required = 1`), the destination account refuses or flags payments without a memo.
- Refunding a pooled account without a memo means the exchange will receive the funds into its
  pool without knowing which user deposited them, causing the buyer's funds to be delayed or lost.

When Quay's preflight check detects `memo_required`:
- The dashboard or API prompts you: `"The buyer's account requires a memo. Ask them for the correct deposit memo before sending the refund."`
- You must contact the buyer, obtain their exchange deposit memo, and enter it into the refund
  prompt before signing.
- When no memo is required by the buyer's account, Quay automatically defaults the memo to
  `refund <reference>`.

---

## What to do when the buyer's account can't receive

If the preflight check fails, Quay returns `refund_destination_cannot_receive` and prevents
you from signing an unexecutable transaction. Here is what each reason means and how to resolve it:

| Preflight Reason | What it means | How to resolve |
| --- | --- | --- |
| `account_not_found` | The buyer's Stellar account does not exist on the ledger or was closed via an account merge. | Contact the buyer and ask them for an active Stellar address. |
| `no_trustline` | The buyer's account does not have a trustline for USDC. This often happens if the buyer paid using another currency (like XLM) through a path payment. | Ask the buyer to open their Stellar wallet and add the USDC trustline, or ask them for an alternate address that accepts USDC. |
| `trustline_not_authorized` | The buyer's USDC trustline has been revoked or frozen by the asset issuer. | The buyer must contact the asset issuer to restore trustline authorization or provide a different wallet address. |
| `trustline_limit_exceeded` | The buyer's account has a custom trustline limit that is too low to receive the refund amount. | Ask the buyer to increase their trustline limit in their wallet settings. |
| `memo_required` | The recipient account is an exchange or pooled account requiring a deposit memo (SEP-29). | Ask the buyer for their exchange deposit memo, enter it into the refund prompt, and proceed. |

---

## Common questions

### What if I close the browser window after preparing the refund?
A prepared refund has a 300-second (5 minute) validity window. If you close the window without
signing, the transaction expires. After expiration, the reserved amount is automatically released
back to the refundable pool, and you can prepare a new refund whenever you are ready.

### Can I refund after cashing out?
Yes. Link settlement and refunds are independent. If you have already cashed out the payment
to your bank account via an anchor, you can still refund your buyer if your Stellar wallet
contains enough USDC to fund the transaction.

### What is the difference between this and an anchor refund?
- **Seller refund (this guide):** You are refunding a customer who purchased from your store. Money moves from your Stellar wallet to the buyer's Stellar wallet.
- **Anchor refund:** You attempted to cash out USDC to local fiat money through an anchor, but the withdrawal failed (e.g. invalid bank account details). The anchor returns the USDC to your wallet (SEP-6/24 `refunded` status). See [Cashing out a payment: a guide for merchants](MERCHANT-CASH-OUT.md) for details.

Related: [HTTP API reference](API.md#refunds) for integrating refunds into your own backend.
