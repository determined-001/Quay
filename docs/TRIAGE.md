# Issue & PR Triage Process

This document defines the issue triage process, labeling rules, response SLAs, and stale issue handling policy for maintainers of Stellar Checkout.

---

## Triage SLAs

| Event | SLA Target | Responsible Party |
| --- | --- | --- |
| **New Issue Triage & Labeling** | Within **48 hours** | Maintainers |
| **First PR Review Feedback** | Within **48 hours** (business days) | Assigned CODEOWNER |
| **Stale Warning Trigger** | **14 days** of inactivity | Maintainers (manual) |
| **Stale Issue Closure** | **30 days** of total inactivity | Maintainers (manual) |

---

## Required Labels on Every Open Issue

No issue should remain untriaged or unlabelled. Every open issue must be assigned labels from each of the three core categories:

1. **`area:*`** — Location in the codebase (`area:core`, `area:stellar`, `area:offramp`, `area:api`, `area:web`, `area:auth`, `area:distribution`, `area:ops`)
2. **`type:*`** — Intent of the issue (`type:bug`, `type:feature`, `type:docs`, `type:test`, `type:refactor`, `type:perf`, `type:security`, `type:dx`, `type:ops`)
3. **`complexity:*`** — Estimated effort (`complexity:trivial` = 100 points, `complexity:medium` = 150, `complexity:high` = 200)

The authoritative definitions live in [`.github/labels.yml`](../.github/labels.yml).
Each `area:*` corresponds to one major in the maintainer's backlog numbering, so
an issue's area and its `<major>.<minor>` id always agree.

Optionally add:
- **`good-first-issue`**: Genuinely self-contained, well-scoped tasks suitable for newcomers.
- **`help-wanted`**: Issues where community contribution is actively invited.
- **`Stellar Wave`**: Opts the issue into the Drips Wave Program.

---

## Stale Issue Policy

To maintain a clean and actionable issue backlog, maintainers apply this by hand
during triage sweeps. There is no stale bot or `actions/stale` workflow in
`.github/workflows/`, and no `stale` label in [`.github/labels.yml`](../.github/labels.yml),
so nothing is warned or closed automatically.

1. **14-Day Warning**: For an issue without activity for 14 consecutive days, a maintainer comments asking if the issue remains relevant or needs assistance.
2. **30-Day Closure**: If no further response or commit activity occurs within **30 days** of initial inactivity, a maintainer closes the issue as stale. Reopening is always welcome if the context becomes relevant again.

---

## PR Review & Merge Policy

1. **No Squashing Policy**:
   - Maintainers must **never squash** PR commits into a single blob commit upon merging.
   - Commit velocity and granular history provide legibility for auditability and code review (see "Stop squashing" under "5. Distribution + SCF packaging" in `MAINTAINER.md`).
   - Merge by **rebase**. `dev` and `main` require linear history, so merge commits are blocked, and squash-merge is not used even though the repository setting allows it (see "Branches and repository settings" in `MAINTAINER.md`).
2. **Verification Gate**:
   - Every PR must pass the required checks `build`, `docker` and `secret-scan` before merge. `build` runs typecheck, tests, coverage, the docs and signing guards, the schema check and the web build; the commands are listed in `CONTRIBUTING.md` ("Before You Open a PR") and the source of truth is `.github/workflows/ci.yml`.
   - Off-ramp mode must remain `seller_initiated` (no switching to `inline`).
