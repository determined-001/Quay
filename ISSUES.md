# Issues

This file tracks discrete engineering issues and their resolution status.
Format: `## <id>. <title>` — one issue per section, newest first within a milestone.

---

## 4.2 — Durable webhook delivery queue

**Milestone:** M2 — Multi-tenant platform
**Complexity:** High (200 points)
**Band lever:** none
**Status:** ✅ Resolved

### Problem

`WebhookSender` retried deliveries in-process with jittered exponential backoff.
Its own docblock acknowledged: *"a crash mid-backoff loses pending retries."*

`link.paid` is the event a merchant's fulfilment flow depends on. Losing it
because the API restarted during a backoff meant an order that was paid on-chain
could be silently undelivered — the failure mode that makes a payments product
untrustworthy. The old `webhook_deliveries` table recorded only the final
outcome, so there was no way to tell an attempt had happened.

### What was done

**Schema** (`apps/api/src/db/schema.ts`, `apps/api/src/db/client.ts`)
- Added `webhook_queue` table:
  `id, webhook_id, link_id, event, payload, attempts, next_attempt_at, status, last_status_code, last_error, created_at, updated_at`.
  Status lifecycle: `pending → claimed → delivered` / `dead`. `dead → pending`
  via the replay endpoint.
- Extended `webhook_deliveries` with `attempt` (1-based attempt number) and
  `queue_entry_id` (FK to the queue row), so every individual attempt is queryable.
- Added `idx_webhook_queue_due` index on `(status, next_attempt_at)` for efficient
  worker polling.

**Core ports** (`packages/core/src/ports/index.ts`)
- Added `WebhookQueueEntry` type and `WebhookQueueStatus` union.
- Extended `WebhookRepository` with `enqueue`, `claimDue`, `updateQueueEntry`,
  `findQueueEntry`, and `findWebhookById`.
- Updated `WebhookDelivery` to include `attempt` and `queueEntryId`.

**Repository** (`apps/api/src/repos/index.ts`)
- `DrizzleWebhookRepository` implements all new queue methods.
- `claimDue` uses a read-then-update pattern with `status = 'pending'` in both
  the SELECT and the UPDATE predicate — acts as an optimistic lock so concurrent
  worker processes cannot double-claim the same row.
- `findWebhookById` added.

**WebhookSender** (`apps/api/src/services/webhook-sender.ts`)
- Completely rewritten: `dispatch()` calls `repo.enqueue` for each registered
  hook and returns immediately. No HTTP calls, no timers.
- Payload is serialised and frozen at enqueue time; the signature is recomputed
  from the frozen payload by the worker, ensuring identical body/signature across
  all retries. Receivers do not need to change anything.

**WebhookWorker** (`apps/api/src/worker/webhook-worker.ts`)
- New polling delivery worker that runs alongside `WatcherLoop`.
- Each tick: claims up to `batchSize` (default 20) due rows, resolves webhook
  secrets, delivers, then:
  - On `2xx` → `delivered`, writes a delivery history row.
  - On transient failure (`5xx`, `429`, network error) + attempts remaining →
    reschedules with exponential backoff + full jitter, writes history row.
  - On transient failure + attempts exhausted → `dead`, writes history row.
  - On permanent failure (`4xx` except `429`) → `dead` immediately.
  - On webhook-not-found (webhook deleted after enqueue) → `dead`.

**Container** (`apps/api/src/services/container.ts`)
- `WebhookWorker` instantiated and wired into `start()` / `stop()`.

**Replay endpoint** (`apps/api/src/routes/webhooks.ts`)
- `POST /webhooks/deliveries/:id/replay` resets a queue entry to
  `pending` with `next_attempt_at = now` and returns 202.
  Returns 409 if the entry is currently `claimed` (in-flight).

**Docs** (`docs/API.md`)
- Old in-process-retry delivery section replaced with durable queue semantics,
  delivery guarantee table, per-attempt history note, and the new replay endpoint.

### Done criteria

- [x] Killing the API mid-backoff still delivers the event after restart.
- [x] Every attempt is queryable (`webhook_deliveries` has per-attempt rows with
      `attempt` + `queue_entry_id`).
- [x] Dead letters are replayable via `POST /webhooks/deliveries/:id/replay`.
- [x] Signing scheme and headers identical to the old sender — receivers unchanged.
