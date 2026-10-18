# @checkout/widget

Embeddable Stellar checkout modal used by Quay. The bundle is an IIFE exposed as
`window.Quay` (and `window.StellarCheckout` for backwards compatibility).

## Install

### Script tag

```html
<script src="https://quay-web.vercel.app/widget.js"></script>

<button data-stellar-checkout="lnk_123">Pay with USDC</button>

<script>
  StellarCheckout.open("lnk_123");
</script>
```

### Module

```ts
import { Quay } from "@checkout/widget";

Quay.open("lnk_123");
```

## Minimal example

```html
<script src="https://quay-web.vercel.app/widget.js"></script>
<button data-quay-link="lnk_123" data-quay-label="Pay 5 USDC">Pay</button>
```

```js
Quay.open("lnk_123");
```

Buttons with `data-quay-link` or `data-stellar-checkout` are bound automatically
when the DOM is ready. `data-quay-label` sets the button text.

## `QuayOpenOptions`

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `linkId` | `string` | yes | Checkout link ID. |
| `host` | `string` | no | Checkout host. If omitted, the widget infers it from its own `<script src="...widget.js">` tag. |
| `onPaid` | `QuayEventHandler` | no | Called when a `quay:paid` message is received. |
| `onClosed` | `QuayEventHandler` | no | Called when the modal is closed. |
| `onError` | `QuayEventHandler` | no | Called when a `quay:error` message is received. |

`Quay.open` accepts either a link ID string or an options object:

```js
Quay.open("lnk_123");
Quay.open({ linkId: "lnk_123", host: "https://checkout.example.com" });
```

If the host cannot be determined, `Quay.open` throws instead of guessing.

## Events

`Quay.on(event, handler)` returns an unsubscribe function.

| Event | Payload |
| --- | --- |
| `quay:paid` | `{ type: "quay:paid", linkId?: string, link?: Record<string, unknown> }` |
| `quay:closed` | `{ type: "quay:closed", linkId?: string }` |
| `quay:error` | `{ type: "quay:error", linkId?: string, error?: string }` |

## `postMessage` contract

The embedded checkout page (`/pay/:id?embed=true`) posts messages to the parent window (`window.parent`). The widget accepts only messages from the expected checkout origin or the widget's own origin.

### Message shape:

```ts
{
  type: "quay:paid" | "quay:closed" | "quay:error";
  linkId?: string;
  link?: Record<string, unknown>;
  error?: string;
}
```

### Event specifications:

- **`quay:paid`**: Posted when the link settles (`paid`, `offramp_pending`, `offramp_settled`, or `offramp_failed`). Guaranteed to fire exactly once per link. Payload carries `{ type: "quay:paid", linkId, link }`.
- **`quay:error`**: Posted when the payment link enters a terminal error state. Payload carries `{ type: "quay:error", linkId, error }` where `error` is:
  - `"expired"`: The link is expired by status or server clock deadline.
  - `"cancelled"`: The seller cancelled the payment link.
  - `"connection_lost"`: Polling repeatedly failed and reached maximum backoff limits.
- **`quay:closed`**: Posted when the buyer clicks the Close action within the embedded checkout frame, prompting the widget modal to close.

### Origin and security rules:

- **Receiving (Widget)**: `e.origin` must equal the checkout host origin, or `window.location.origin`. Messages from any other origin are ignored.
- **Sending (Checkout iframe)**: Uses `document.referrer` origin as `targetOrigin` when valid, falling back to `"*"` (the posted payloads contain only public payment details, with no credentials or secrets).

## Build and size budget

Build the bundle:

```sh
npm run build
```

The build writes `dist/widget.js`, copies it to `apps/web/public/widget.js`,
and enforces a hard gzipped size budget of **5 KB (5120 bytes)**.

## Link from root README

See the root README quickstart for the script-tag integration example.
