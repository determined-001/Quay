import type {
  AnchorSession,
  AnchorSessionRepository,
  OffRampStateRepository,
  StoredOffRampJob,
  StoredOffRampQuote,
} from "@checkout/core";

/**
 * In-memory `OffRampStateRepository` for tests. Two adapter instances pointed
 * at the *same* `FakeOffRampStateRepository` simulate a process restart: the
 * first instance stands in for the pre-restart process, the second for the
 * fresh one, sharing only what actually got persisted.
 */
export class FakeOffRampStateRepository implements OffRampStateRepository {
  private readonly quotes = new Map<string, StoredOffRampQuote>();
  private readonly jobs = new Map<string, StoredOffRampJob>();

  async saveQuote(quote: StoredOffRampQuote): Promise<void> {
    this.quotes.set(quote.quoteId, quote);
  }

  async getQuote(quoteId: string): Promise<StoredOffRampQuote | null> {
    return this.quotes.get(quoteId) ?? null;
  }

  async saveJob(job: StoredOffRampJob): Promise<void> {
    this.jobs.set(job.jobId, job);
  }

  async getJob(jobId: string): Promise<StoredOffRampJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, { ...job, ...patch, updatedAt: Date.now() });
  }
}

/** In-memory `AnchorSessionRepository`, keyed like the real table. */
export class FakeAnchorSessionRepository implements AnchorSessionRepository {
  readonly sessions = new Map<string, AnchorSession>();

  async get(sellerId: string, anchorDomain: string): Promise<AnchorSession | null> {
    return this.sessions.get(`${sellerId} ${anchorDomain}`) ?? null;
  }

  async save(session: AnchorSession): Promise<void> {
    this.sessions.set(`${session.sellerId} ${session.anchorDomain}`, session);
  }

  async delete(sellerId: string, anchorDomain: string): Promise<void> {
    this.sessions.delete(`${sellerId} ${anchorDomain}`);
  }
}
