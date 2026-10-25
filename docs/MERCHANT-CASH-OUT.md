# Cashing out a payment: a guide for merchants

When a customer pays your Quay link, the USDC lands in **your own Stellar
wallet**. Quay never holds it. "Cashing out" means asking a Stellar **anchor**
(a licensed business that turns USDC into local money) to pay you in your local
currency. This guide walks through it step by step, and says what each thing your
wallet asks you to sign can and cannot do.

> **Testnet only.** Cash-out is available on the testnet deployment
> (https://quay-web.vercel.app), which talks to the Stellar test anchor
> `testanchor.stellar.org`. **Testnet moves no real money**: the USDC is test
> USDC and nothing is paid to a bank. The production (mainnet) deployment takes
> payments only and has no cash-out button.

## Before you start

You need:

- A Stellar wallet. This guide uses [Freighter](https://www.freighter.app/)
  with its network set to **Testnet**.
- The wallet funded with test XLM. Free from Friendbot:
  `https://friendbot.stellar.org/?addr=` followed by your `G...` address.
- A **USDC trustline** on that wallet, for the testnet issuer
  `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`. Without one your
  wallet cannot hold or send USDC. In Freighter use **Manage assets**.
- A paid link. A link has to be `paid` before the cash-out button appears.
- An amount the test anchor accepts: **1 to 10 USDC per withdrawal** (published
  in the anchor's `/sep6/info`). Outside that range the anchor refuses with a
  message that names its limits.
- The test anchor only quotes **USD or CAD**, so a testnet deployment is
  configured with one of those and the button reads, for example, "Cash out to
  USD".

Use the same wallet you signed in to Quay with. The anchor knows you by that
wallet address and the transfer in step 4 must come from it.

## The five steps

```
 1. Connect to the anchor   ->  prove to the anchor that this wallet is yours
 2. Verify your identity    ->  tell the anchor who you are (once)
 3. Cash out a paid link    ->  get a quote and confirm it
 4. Send the transfer       ->  your wallet pays the USDC to the anchor
 5. Track it                ->  paid -> offramp_pending -> offramp_settled
```

### 1. Connect to the anchor

**What you see.** In the **Identity verification** panel of your dashboard: a
short explanation and a button **Connect to testanchor.stellar.org**.

**What you sign.** Your wallet opens and asks you to sign a *challenge* from the
anchor. This is a login proof (SEP-10), not a payment.

**What it can and cannot do.** The challenge is a transaction that is **never
submitted to the network** and has a sequence number of zero, so it can never be
executed. It cannot move funds. All it does is tell the anchor that the wallet
address is really you, which is how the anchor tells its customers apart. Quay
keeps the anchor's resulting session token encrypted and uses it only to follow
your withdrawals. If you sign out or change wallet, the session is forgotten.

**What can go wrong.**
- *No wallet found*: install Freighter and reload.
- *The wallet is on the wrong network*: switch Freighter to Testnet.
- *"The anchor rejected the sign-in challenge. Please try again."*: just press
  the button again.
- *Your session expires*: you will see a banner "Your session with
  testanchor.stellar.org expired" with **Reconnect to testanchor.stellar.org**
  (or "expires soon" with **Renew now**). Pressing it repeats this step. Cash-outs
  already started keep waiting, but Quay cannot follow them until you reconnect
  (a link then shows "waiting for reconnect").

### 2. Verify your identity

**What you see.** Still in the **Identity verification** panel: **Start
verification**. Quay asks the anchor what it needs, then shows a form with those
fields (for example name, email, address, and sometimes a photo of an ID). Before
anything is sent you get a dialog, **Share identity with testanchor.stellar.org?**,
listing exactly the fields, with **Share these fields**. Fill in the form and
press **Submit**.

**What you sign.** Nothing. There is no wallet signature in this step. You are
giving the anchor information and agreeing to share it.

**What it can and cannot do.** The anchor needs to know its customer before it
pays out; this is called SEP-12 verification. Only the fields the anchor asked
for are sent, and only after you agree. ID photos go straight to the anchor and
are not stored by Quay. You can see what you shared under **Consent history**.
This step cannot move funds.

**What to expect.** The panel shows **Submitted — the anchor is reviewing it.**
while the anchor checks, then **Verified — you can cash out to local currency.**
once it is accepted. You only do this once per anchor.

**What can go wrong.**
- *"Rejected: ..."*: the anchor refused something. Correct the highlighted
  fields and resubmit.
- *"The anchor still needs the following ..."*: fill in the fields it lists.
- *A field is marked invalid*: the form checks formats (for example email) before
  you can submit.

### 3. Cash out a paid link

**What you see.** In your links table, a paid link shows **Cash out to USD**
(it only appears once verification is complete; before that the row says
*Identity verification required*). Pressing it opens a window:

1. **Payout details.** The fields the anchor wants (for example a bank account).
   If the anchor offers several ways to be paid you first choose *How should the
   money arrive?*. Details you used last time are remembered and shown masked
   (only the last four characters), so you only re-type what changed.
2. **Get quote.** Quay asks the anchor for a rate. You see what you send, the
   gross amount, the fee, **what you receive**, the exchange rate and a
   countdown: *Quote valid for ...*. A quote labelled **Indicative** means the
   anchor sets the final amount, so treat the figure as an estimate; **Firm**
   means the anchor promised it.
3. **Confirm cash-out.** This starts the withdrawal. If the countdown runs out,
   press **Get a new quote**.

**What you sign.** Nothing yet. Confirming does not send any money.

**What it cannot do.** Confirming only tells the anchor "I intend to withdraw
this much". Your USDC stays in your wallet until step 4.

**What can go wrong.**
- *"The anchor only accepts cash-outs between 1 and 10 ..."*: change the amount
  (the test anchor takes 1 to 10 USDC).
- *"Identity verification is required before you can cash out."*: finish step 2.
- *"Sign in to the anchor with your wallet first."*: do step 1 again.
- *"The quote expired before the transaction could complete."* or *"This quote no
  longer matches the link."*: press **Get a new quote**.
- *"The anchor is currently unavailable. Please try again later."*: the anchor
  is down; wait and retry.

### 4. Send the transfer

**What you see.** Once the anchor tells Quay where to send the USDC, the window
shows: *The anchor is ready. Send **N USDC** from your wallet to finish the
cash-out*, with the **destination** (shortened) and the **memo**, and a button
**Send with my wallet**. If the anchor is still doing its own checks first, you
instead see *"The anchor will tell us where to send the USDC once it has
finished its checks"*. Press **Done**; the send step appears later (see "If you
close the window" below).

**What you sign.** A real payment of exactly that amount of USDC to that
destination with that memo, from your wallet. Your wallet shows the same
details; check them before you approve.

**What it can and cannot do.** This is the one signature that **moves money**,
and it moves only what is shown: the amount, to the anchor's account. Quay
cannot send it for you and never holds your keys, which is why it asks your
wallet. The **memo** is how the anchor matches your payment to your withdrawal:
without it the anchor cannot tell the payment is yours. The anchor pays you out
**only after it sees this payment** on the network.

If you prefer, **Pay from another device** shows a QR code and **Open in a wallet
app** link that carry the same payment. It must still come from the same wallet.

**What can go wrong.**
- *Your wallet needs a trustline or more balance*: the window checks first and
  tells you ("Checking wallet balance..."). Fix it and press **Check again**.
- *The wallet refused or you cancelled*: you see **"The payment was not sent: ..."**.
  Nothing was paid. Press **Send with my wallet** again.
- *Never send twice.* Once sent, the window says **Payment sent, waiting for the
  anchor to see it** with the transaction hash. A second payment would be paid
  to the anchor again and would need a manual refund.

### 5. Track it

A link moves from `paid` to `offramp_pending` when you confirm, then to
`offramp_settled` when the anchor has paid out, or `offramp_failed` if it could
not. Open the link's page (click its title) to see the timeline. Quay checks the
anchor in the background, so you do not need to keep the window open. If you
use webhooks, you also get `offramp.transfer_required`, `offramp.settled` and
`offramp.failed` events (see the [API reference](API.md#webhook-delivery)).

If a cash-out fails, the link shows **Retry cash-out**; it takes you through
steps 3 and 4 again.

## If you close the window before sending

Closing the window after confirming does **not** cancel the withdrawal and does
**not** send money. The link stays `offramp_pending` and the anchor keeps
waiting for your payment. To finish, press **Send USDC to finish cash-out** next
to the link in the dashboard (or on the link's page). It reloads the same
instructions, with the same memo, and the same **Send with my wallet** button.

Do **not** start a second cash-out for the same link. If you are not sure whether
your payment went through, look at your wallet's history for a payment to the
anchor with the memo; if it is there, wait. If a link has been
`offramp_pending` a long time after you sent, ask the operator to follow the
"Stuck `offramp_pending` job" section of the
[runbook](RUNBOOK.md#stuck-offramp_pending-job).

## Common problems

| What you see | What it means | What to do |
| --- | --- | --- |
| The anchor window did not open (some anchors need one) | Your browser blocked the popup | The window offers **Open the anchor page directly**. Use that link, finish there, then come back |
| **Identity verification required** instead of a cash-out button | Step 2 is not finished | Finish verification in the panel above the table |
| *"Sign in to the anchor with your wallet first."* or a banner *"Your session with ... expired"* | Your anchor session lapsed (step 1) | Press **Reconnect** and sign the challenge. Safe: it cannot move funds |
| **"The payment was not sent: ..."** | Your wallet refused, was on the wrong network, or lacks a trustline or balance | Fix what the message says and press **Send with my wallet** again. Nothing was paid |
| The send button is disabled and a red message appears | The pre-check found a missing trustline, too little balance, or the wrong wallet | Add the USDC trustline, fund the wallet, or switch to the wallet you signed in with, then **Check again** |
| *"The anchor only accepts cash-outs between 1 and 10 ..."* | The link amount is outside the anchor's limits | The test anchor takes 1 to 10 USDC. Use a link in that range |
| You closed the window before sending | Withdrawal waits for your payment | Press **Send USDC to finish cash-out** on the link |
| The link says *waiting for reconnect* | Your anchor session lapsed while a cash-out was open | Reconnect (step 1); Quay resumes tracking |
| Link shows `offramp_failed` | The anchor could not complete the payout | Press **Retry cash-out**. If you already sent USDC to the anchor, contact the operator before retrying |

Related: [HTTP API reference](API.md#cash-out-off-ramp-flow) for the same flow
as API calls, and the [Runbook](RUNBOOK.md) for operators.
