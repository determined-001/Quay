import type { Asset, Horizon } from "@stellar/stellar-sdk";
import type {
  HorizonAccount,
  HorizonAccountBalance,
  HorizonClient,
  HorizonPaymentRecord,
  PaymentsCallBuilder,
  StrictReceivePathsCallBuilder,
} from "../src/horizon-client";

interface Listener {
  onmessage: (record: HorizonPaymentRecord) => void;
  onerror: (err: unknown) => void;
}

export interface FakePaymentInput {
  account: string;
  to?: string;
  from?: string;
  amount?: string;
  assetCode?: string;
  assetIssuer?: string | null;
  memo?: string | null;
  memoType?: string | null;
  type?: string; // defaults to "payment"; set e.g. "create_account" to test filtering
}

/**
 * In-memory stand-in for Horizon's payments endpoint (paged + SSE), structurally
 * compatible with `HorizonClient`. Lets the same contract test suite drive both
 * `HorizonWatcher` (call()) and `StreamingHorizonWatcher` (stream()) without a
 * live network.
 */
export class FakeHorizonClient implements HorizonClient {
  private nextToken = 1;
  private readonly ledger = new Map<string, HorizonPaymentRecord[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private notFoundAccounts = new Set<string>();
  private readonly balances = new Map<string, HorizonAccountBalance[]>();
  private strictReceivePathsRecords: Horizon.ServerApi.PaymentPathRecord[] = [];
  private strictReceivePathsFailures: unknown[] = [];
  private strictReceivePathsCalls = 0;
  private lastStrictReceivePathsArgs: {
    source: string | Asset[];
    destinationAsset: Asset;
    destinationAmount: string;
  } | null = null;

  payments(): PaymentsCallBuilder {
    return new FakeBuilder(this);
  }

  async loadAccount(account: string): Promise<HorizonAccount> {
    if (this.notFoundAccounts.has(account)) {
      const err = new Error("not found") as Error & {
        response: { status: number };
      };
      err.response = { status: 404 };
      throw err;
    }
    return { balances: this.balances.get(account) ?? [] };
  }

  /** Canned `GET /paths/strict-receive` records returned by the stub. */
  setStrictReceivePaths(records: Horizon.ServerApi.PaymentPathRecord[]): void {
    this.strictReceivePathsRecords = [...records];
  }

  /** Makes the next `times` strict-receive calls throw `err` (retry testing). */
  failStrictReceivePaths(err: unknown, times = 1): void {
    for (let i = 0; i < times; i += 1) this.strictReceivePathsFailures.push(err);
  }

  strictReceivePathsCallCount(): number {
    return this.strictReceivePathsCalls;
  }

  lastStrictReceivePathsCall(): {
    source: string | Asset[];
    destinationAsset: Asset;
    destinationAmount: string;
  } | null {
    return this.lastStrictReceivePathsArgs;
  }

  strictReceivePaths(
    source: string | Asset[],
    destinationAsset: Asset,
    destinationAmount: string,
  ): StrictReceivePathsCallBuilder {
    this.lastStrictReceivePathsArgs = { source, destinationAsset, destinationAmount };
    return {
      call: async () => {
        this.strictReceivePathsCalls += 1;
        const failure = this.strictReceivePathsFailures.shift();
        if (failure !== undefined) throw failure;
        return { records: [...this.strictReceivePathsRecords] };
      },
    };
  }

  /** Registers a trustline (with balance/limit) for `loadAccount`-based preflight checks. */
  setTrustline(account: string, line: HorizonAccountBalance): void {
    const list = this.balances.get(account) ?? [];
    list.push(line);
    this.balances.set(account, list);
  }

  /** Marks an account as never-created on-chain: call()/stream() surface a 404. */
  markNotFound(account: string): void {
    this.notFoundAccounts.add(account);
  }

  isNotFoundAccount(account: string): boolean {
    return this.notFoundAccounts.has(account);
  }

  recordsFor(account: string): HorizonPaymentRecord[] {
    return this.ledger.get(account) ?? [];
  }

  addPayment(input: FakePaymentInput): HorizonPaymentRecord {
    this.notFoundAccounts.delete(input.account);
    const token = String(this.nextToken++);
    const record = {
      type: input.type ?? "payment",
      paging_token: token,
      transaction_hash: `tx_${token}`,
      created_at: new Date().toISOString(),
      to: input.to ?? input.account,
      from: input.from ?? "GFROM_DEFAULT",
      amount: input.amount ?? "10",
      asset_type: input.assetCode ? "credit_alphanum4" : "native",
      asset_code: input.assetCode,
      asset_issuer: input.assetIssuer ?? undefined,
      transaction: async () => ({
        memo_type: input.memoType ?? (input.memo ? "text" : "none"),
        memo: input.memo ?? undefined,
      }),
    } as unknown as HorizonPaymentRecord;

    return this.addRecord(input.account, record);
  }

  /**
   * Files a verbatim Horizon record (e.g. a JSON fixture) under `account` and
   * notifies live subscribers — the fixture path through the watchers, without
   * FakePaymentInput having to grow a field for every path payment column.
   */
  addRecord(account: string, record: HorizonPaymentRecord): HorizonPaymentRecord {
    this.notFoundAccounts.delete(account);
    const list = this.ledger.get(account) ?? [];
    list.push(record);
    this.ledger.set(account, list);

    for (const listener of this.listeners.get(account) ?? []) {
      listener.onmessage(record);
    }
    return record;
  }

  /** Pushes an arbitrary record directly to registered SSE listeners for testing. */
  pushMessage(account: string, record: HorizonPaymentRecord): void {
    for (const listener of this.listeners.get(account) ?? []) {
      listener.onmessage(record);
    }
  }

  /** Simulates a dropped SSE connection for every live subscriber on `account`. */
  killConnection(
    account: string,
    err: unknown = new Error("connection reset"),
  ): void {
    for (const listener of this.listeners.get(account) ?? []) {
      listener.onerror(err);
    }
  }

  liveSubscriberCount(account: string): number {
    return this.listeners.get(account)?.size ?? 0;
  }

  subscribe(account: string, listener: Listener): void {
    const set = this.listeners.get(account) ?? new Set();
    set.add(listener);
    this.listeners.set(account, set);
  }

  unsubscribe(account: string, listener: Listener): void {
    this.listeners.get(account)?.delete(listener);
  }
}

class FakeBuilder implements PaymentsCallBuilder {
  private account = "";
  private direction: "asc" | "desc" = "asc";
  private limitN = 200;
  private cursorToken = "";

  constructor(private readonly client: FakeHorizonClient) {}

  forAccount(account: string): PaymentsCallBuilder {
    this.account = account;
    return this;
  }
  order(direction: "asc" | "desc"): PaymentsCallBuilder {
    this.direction = direction;
    return this;
  }
  limit(n: number): PaymentsCallBuilder {
    this.limitN = n;
    return this;
  }
  cursor(token: string): PaymentsCallBuilder {
    this.cursorToken = token;
    return this;
  }
  join(_resource: "transactions"): PaymentsCallBuilder {
    // The fake always embeds `transaction` on its records, so the join is a
    // no-op here — it exists so the builder still satisfies the interface.
    return this;
  }

  async call(): Promise<{ records: HorizonPaymentRecord[] }> {
    if (this.client.isNotFoundAccount(this.account)) {
      const err = new Error("not found") as Error & {
        response: { status: number };
      };
      err.response = { status: 404 };
      throw err;
    }
    let records = this.client
      .recordsFor(this.account)
      .filter(
        (r) =>
          !this.cursorToken ||
          Number((r as any).paging_token) > Number(this.cursorToken),
      );
    records = [...records].sort(
      (a, b) =>
        Number((a as any).paging_token) - Number((b as any).paging_token),
    );
    if (this.direction === "desc") records.reverse();
    return { records: records.slice(0, this.limitN) };
  }

  stream(opts: {
    onmessage: (record: HorizonPaymentRecord) => void;
    onerror: (err: unknown) => void;
  }): () => void {
    const listener: Listener = {
      onmessage: opts.onmessage,
      onerror: opts.onerror,
    };
    // Register before replaying the backlog: JS is single-threaded, so nothing
    // can append between these two statements and be missed or double-delivered.
    this.client.subscribe(this.account, listener);
    const backlog = this.client
      .recordsFor(this.account)
      .filter(
        (r) =>
          !this.cursorToken ||
          Number((r as any).paging_token) > Number(this.cursorToken),
      )
      .sort(
        (a, b) =>
          Number((a as any).paging_token) - Number((b as any).paging_token),
      );
    for (const record of backlog) opts.onmessage(record);

    return () => this.client.unsubscribe(this.account, listener);
  }
}
