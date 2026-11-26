"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createInvoiceSchema, invoiceTotal } from "@checkout/core";
import type { Invoice, InvoiceInput } from "../../../lib/api";
import { CheckIcon, CloseIcon, CopyIcon, PlusIcon } from "./icons";
import { useFocusTrap } from "../useFocusTrap";

const MAX_LINES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What `onSave` and `onIssue` may throw. The message is shown as is. When the
 * API refused because the seller's wallet cannot receive the asset (422
 * `destination_cannot_receive`), `trustlineUri` carries its link to fix that.
 */
export class InvoiceSheetError extends Error {
  constructor(
    message: string,
    readonly trustlineUri?: string,
  ) {
    super(message);
    this.name = "InvoiceSheetError";
  }
}

interface Line {
  /** Stable across re-renders, so removing a row does not move focus or values to another. */
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
}

const FIELD_LABEL: Record<string, string> = {
  clientName: "Client name",
  clientEmail: "Client email",
  clientAddress: "Client address",
  notes: "Notes",
  dueAt: "Due date",
  lineItems: "Line items",
  description: "description",
  quantity: "quantity",
  unitPrice: "unit price",
};

/** `2026-11-26` for a local date, the value of a date input. */
function toDateInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The last millisecond of that local day: an invoice due on the 10th is not late during the 10th. */
function dueAtFromDateInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** The API's quantity is an integer count. Anything else is left for the schema to refuse. */
function parseQuantity(raw: string): number {
  const text = raw.trim();
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

function toLineItems(lines: Line[]) {
  return lines.map((line) => ({
    description: line.description,
    quantity: parseQuantity(line.quantity),
    unitPrice: line.unitPrice.trim(),
  }));
}

/** The exact total of the lines as typed, or null while any line is incomplete or invalid. */
export function liveInvoiceTotal(lines: Array<Pick<Line, "quantity" | "unitPrice">>): string | null {
  try {
    return invoiceTotal(
      lines.map((line) => ({ description: "x", quantity: parseQuantity(line.quantity), unitPrice: line.unitPrice.trim() })),
    );
  } catch {
    return null;
  }
}

/** The first problem the core schema finds, worded for the field it is in. */
function firstProblem(issue: { path: PropertyKey[]; message: string }): string {
  const [head, index, leaf] = issue.path;
  if (head === "lineItems" && typeof index === "number") {
    const field = typeof leaf === "string" ? (FIELD_LABEL[leaf] ?? leaf) : "";
    return `Line ${index + 1}${field ? ` ${field}` : ""}: ${issue.message}`;
  }
  const label = typeof head === "string" ? (FIELD_LABEL[head] ?? head) : "";
  return label ? `${label}: ${issue.message}` : issue.message;
}

/**
 * A dialog for making an invoice: who it is for, what it is for, and when it
 * is due. "Save draft" keeps it editable; "Issue invoice" saves it and then
 * issues it, which gives it a number and a page to send to the client. Once
 * issued it becomes the "here it is" screen, like the payment-link sheet.
 */
export default function InvoiceSheet({
  invoice,
  onClose,
  onSave,
  onIssue,
}: {
  /** A draft to edit. Omitted for a new invoice. */
  invoice?: Invoice;
  onClose: () => void;
  /** Creates the draft (`id` null) or updates it. Resolves with the saved draft, or throws an `InvoiceSheetError`. */
  onSave: (values: InvoiceInput, id: string | null) => Promise<Invoice>;
  /** Issues a saved draft. Resolves with the issued invoice, or throws an `InvoiceSheetError`. */
  onIssue: (id: string) => Promise<Invoice>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const uid = useId();
  const nextKey = useRef(invoice?.lineItems.length ?? 1);
  const focusKey = useRef<number | null>(null);

  const [draftId, setDraftId] = useState<string | null>(invoice?.id ?? null);
  const [clientName, setClientName] = useState(invoice?.clientName ?? "");
  const [clientEmail, setClientEmail] = useState(invoice?.clientEmail ?? "");
  const [clientAddress, setClientAddress] = useState(invoice?.clientAddress ?? "");
  const [assetCode, setAssetCode] = useState<"USDC" | "XLM">(invoice?.assetCode === "XLM" ? "XLM" : "USDC");
  const [dueDate, setDueDate] = useState(() => toDateInput(invoice?.dueAt ?? Date.now() + 14 * DAY_MS));
  const [notes, setNotes] = useState(invoice?.notes ?? "");
  const [lines, setLines] = useState<Line[]>(() =>
    invoice && invoice.lineItems.length > 0
      ? invoice.lineItems.map((item, key) => ({
          key,
          description: item.description,
          quantity: String(item.quantity),
          unitPrice: item.unitPrice,
        }))
      : [{ key: 0, description: "", quantity: "1", unitPrice: "" }],
  );
  const [busy, setBusy] = useState<"save" | "issue" | null>(null);
  const [error, setError] = useState<{ message: string; trustlineUri?: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [issued, setIssued] = useState<Invoice | null>(null);
  const [copied, setCopied] = useState(false);

  // Escape closes the sheet unless a request is in flight.
  useFocusTrap(ref, true, () => {
    if (!busy) onClose();
  });

  // Focus moves to the row that was just added.
  useEffect(() => {
    if (focusKey.current === null) return;
    const key = focusKey.current;
    focusKey.current = null;
    ref.current?.querySelector<HTMLInputElement>(`[data-line-description="${key}"]`)?.focus();
  }, [lines.length]);

  const total = liveInvoiceTotal(lines);

  function editLine(key: number, patch: Partial<Omit<Line, "key">>) {
    setSaved(false);
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function addLine() {
    if (lines.length >= MAX_LINES) return;
    const key = nextKey.current++;
    focusKey.current = key;
    setLines((prev) => [...prev, { key, description: "", quantity: "1", unitPrice: "" }]);
  }

  function removeLine(key: number) {
    if (lines.length <= 1) return;
    setSaved(false);
    setLines((prev) => prev.filter((line) => line.key !== key));
  }

  /** The body for the API, checked with the schema the API uses, or null with the problem shown. */
  function values(): InvoiceInput | null {
    const dueAt = dueAtFromDateInput(dueDate);
    if (dueAt === null) {
      setError({ message: "Due date: choose a date." });
      return null;
    }
    const parsed = createInvoiceSchema.safeParse({
      clientName,
      clientEmail: clientEmail.trim() === "" ? null : clientEmail,
      clientAddress: clientAddress.trim() === "" ? null : clientAddress,
      notes: notes.trim() === "" ? null : notes,
      assetCode,
      lineItems: toLineItems(lines),
      dueAt,
    });
    if (!parsed.success) {
      setError({ message: firstProblem(parsed.error.issues[0]!) });
      return null;
    }
    return parsed.data;
  }

  function fail(err: unknown, fallback: string) {
    setError(
      err instanceof InvoiceSheetError
        ? { message: err.message, trustlineUri: err.trustlineUri }
        : { message: err instanceof Error ? err.message : fallback },
    );
  }

  /** Saves the draft and returns its id, or null when it could not be saved. */
  async function save(): Promise<string | null> {
    const body = values();
    if (!body) return null;
    try {
      const draft = await onSave(body, draftId);
      setDraftId(draft.id);
      return draft.id;
    } catch (err) {
      fail(err, "Failed to save the invoice. Please try again.");
      return null;
    }
  }

  async function saveDraft() {
    setError(null);
    setSaved(false);
    setBusy("save");
    try {
      if (await save()) setSaved(true);
    } finally {
      setBusy(null);
    }
  }

  // Issuing a new invoice saves the draft first, then issues it. If issuing is
  // refused the draft is kept, so nothing typed is lost.
  async function issue(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy("issue");
    try {
      const id = await save();
      if (!id) return;
      try {
        setIssued(await onIssue(id));
      } catch (err) {
        fail(err, "Failed to issue the invoice. It was saved as a draft.");
      }
    } finally {
      setBusy(null);
    }
  }

  const url = issued && typeof window !== "undefined" ? `${window.location.origin}/invoice/${issued.id}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The link stays visible and selectable if the browser refuses clipboard access.
    }
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <button type="button" className="sheet__close" onClick={onClose} aria-label="Close" disabled={busy !== null}>
          <CloseIcon />
        </button>

        {!issued ? (
          <form onSubmit={issue} noValidate>
            <h2 id={headingId}>{draftId ? "Edit invoice" : "New invoice"}</h2>
            <p className="card__hint">
              Your client pays from their own wallet and it lands in yours. A draft can be changed; an issued invoice
              cannot.
            </p>

            <div className="field">
              <label htmlFor={`${uid}-client`}>Client name</label>
              <input
                id={`${uid}-client`}
                data-autofocus
                value={clientName}
                onChange={(e) => {
                  setSaved(false);
                  setClientName(e.target.value);
                }}
                autoComplete="off"
              />
            </div>

            <div className="field">
              <label htmlFor={`${uid}-email`}>Client email (optional)</label>
              <input
                id={`${uid}-email`}
                type="email"
                value={clientEmail}
                onChange={(e) => {
                  setSaved(false);
                  setClientEmail(e.target.value);
                }}
                autoComplete="off"
              />
            </div>

            <div className="field">
              <label htmlFor={`${uid}-address`}>Client address (optional)</label>
              <textarea
                id={`${uid}-address`}
                rows={2}
                value={clientAddress}
                onChange={(e) => {
                  setSaved(false);
                  setClientAddress(e.target.value);
                }}
              />
            </div>

            <div className="row">
              <div className="field">
                <label htmlFor={`${uid}-asset`}>Currency</label>
                <select
                  id={`${uid}-asset`}
                  value={assetCode}
                  onChange={(e) => {
                    setSaved(false);
                    setAssetCode(e.target.value as "USDC" | "XLM");
                  }}
                >
                  <option value="USDC">USDC</option>
                  <option value="XLM">XLM</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${uid}-due`}>Due date</label>
                <input
                  id={`${uid}-due`}
                  type="date"
                  value={dueDate}
                  onChange={(e) => {
                    setSaved(false);
                    setDueDate(e.target.value);
                  }}
                />
              </div>
            </div>

            {lines.map((line, index) => (
              <fieldset key={line.key} className="invoice-line" data-testid={`invoice-line-${index + 1}`}>
                <legend>Line {index + 1}</legend>
                <div className="field">
                  <label htmlFor={`${uid}-d-${line.key}`}>Description</label>
                  <input
                    id={`${uid}-d-${line.key}`}
                    data-line-description={line.key}
                    aria-label={`Line ${index + 1} description`}
                    value={line.description}
                    onChange={(e) => editLine(line.key, { description: e.target.value })}
                    autoComplete="off"
                  />
                </div>
                <div className="row">
                  <div className="field">
                    <label htmlFor={`${uid}-q-${line.key}`}>Quantity</label>
                    <input
                      id={`${uid}-q-${line.key}`}
                      className="mono"
                      inputMode="numeric"
                      aria-label={`Line ${index + 1} quantity`}
                      value={line.quantity}
                      onChange={(e) => editLine(line.key, { quantity: e.target.value })}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${uid}-p-${line.key}`}>Unit price</label>
                    <input
                      id={`${uid}-p-${line.key}`}
                      className="mono"
                      inputMode="decimal"
                      aria-label={`Line ${index + 1} unit price`}
                      value={line.unitPrice}
                      onChange={(e) => editLine(line.key, { unitPrice: e.target.value })}
                      autoComplete="off"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="chip"
                  onClick={() => removeLine(line.key)}
                  disabled={lines.length <= 1}
                  aria-label={`Remove line ${index + 1}`}
                >
                  Remove
                </button>
              </fieldset>
            ))}

            <button type="button" className="chip" onClick={addLine} disabled={lines.length >= MAX_LINES}>
              <PlusIcon /> Add line
            </button>

            <p className="invoice-total" aria-live="polite">
              Total{" "}
              <span className="mono" data-testid="invoice-total">
                {total === null ? "—" : `${total} ${assetCode}`}
              </span>
            </p>

            <div className="field">
              <label htmlFor={`${uid}-notes`}>Notes (optional)</label>
              <textarea
                id={`${uid}-notes`}
                rows={2}
                value={notes}
                onChange={(e) => {
                  setSaved(false);
                  setNotes(e.target.value);
                }}
              />
            </div>

            {error && (
              <div className="err" role="alert">
                {error.message}
                {error.trustlineUri && (
                  <>
                    {" "}
                    <a href={error.trustlineUri} target="_blank" rel="noopener noreferrer">
                      Add the trustline
                    </a>
                  </>
                )}
              </div>
            )}
            {saved && !error && (
              <p className="card__hint" role="status">
                Draft saved.
              </p>
            )}

            <div className="sheet__actions">
              <button type="button" className="btn" onClick={saveDraft} disabled={busy !== null}>
                {busy === "save" ? "Saving…" : "Save draft"}
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy !== null}>
                {busy === "issue" ? "Issuing…" : "Issue invoice"}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <span className="sheet__done" aria-hidden>
              <CheckIcon />
            </span>
            <h2 id={headingId}>Invoice {issued.number} is issued</h2>
            <p className="card__hint">Send this page to your client. They can read the invoice and pay it there.</p>

            <div className="sharebox">
              <code>{url}</code>
              <button type="button" className="chip chip--solid" onClick={copy}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>

            <div className="sheet__actions">
              <button type="button" className="btn btn--primary" onClick={onClose} data-autofocus>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
