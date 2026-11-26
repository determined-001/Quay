// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/components/SessionGate", () => ({
  useSellerWallet: () => "GSELLERWALLET",
  useSellerSession: () => ({ address: "GSELLERWALLET", busy: false, signOut: () => {} }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { api, type Invoice, type InvoiceInput } from "../lib/api";
import InvoiceSheet, { InvoiceSheetError, liveInvoiceTotal } from "../app/components/dashboard/InvoiceSheet";

// Issue 5.52 (#563): build, edit and issue an invoice from a sheet.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function invoiceFrom(values: InvoiceInput, over: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv_1",
    number: null,
    clientName: values.clientName,
    clientEmail: values.clientEmail ?? null,
    clientAddress: values.clientAddress ?? null,
    lineItems: values.lineItems,
    total: "0",
    assetCode: values.assetCode,
    issuedAt: null,
    dueAt: values.dueAt,
    status: "draft",
    linkId: null,
    notes: values.notes ?? null,
    ...over,
  };
}

type Save = (values: InvoiceInput, id: string | null) => Promise<Invoice>;
type Issue = (id: string) => Promise<Invoice>;

async function open(props: { invoice?: Invoice; onSave?: Save; onIssue?: Issue; onClose?: () => void } = {}) {
  const onSave = vi.fn<Save>(props.onSave ?? (async (values) => invoiceFrom(values)));
  const onIssue = vi.fn<Issue>(
    props.onIssue ??
      (async (id) => ({ ...invoiceFrom({ clientName: "x", assetCode: "USDC", lineItems: [], dueAt: 0 }), id, number: "INV-0007", status: "open" })),
  );
  const onClose = vi.fn(props.onClose ?? (() => {}));
  await act(async () => {
    root.render(<InvoiceSheet invoice={props.invoice} onClose={onClose} onSave={onSave} onIssue={onIssue} />);
  });
  return { onSave, onIssue, onClose };
}

function field<T extends HTMLElement = HTMLInputElement>(label: string): T {
  const byAria = container.querySelector<T>(`[aria-label="${label}"]`);
  if (byAria) return byAria;
  const el = [...container.querySelectorAll("label")].find((l) => l.textContent === label);
  if (!el) throw new Error(`no field labelled ${label}`);
  return container.querySelector<T>(`#${CSS.escape(el.getAttribute("for")!)}`)!;
}

async function type(el: HTMLElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function button(name: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
  );
  if (!el) throw new Error(`no button named ${name}`);
  return el;
}

async function click(name: string) {
  await act(async () => {
    button(name).click();
  });
  await settle();
}

async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function fillValid() {
  await type(field("Client name"), "Ada Obi");
  await type(field("Line 1 description"), "Design work");
  await type(field("Line 1 quantity"), "3");
  await type(field("Line 1 unit price"), "0.1000001");
}

// A due date the schema accepts: in the future and less than a year out.
const DUE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const pad = (n: number) => String(n).padStart(2, "0");
const DUE_INPUT = `${DUE.getFullYear()}-${pad(DUE.getMonth() + 1)}-${pad(DUE.getDate())}`;
const DUE_AT = new Date(DUE.getFullYear(), DUE.getMonth(), DUE.getDate(), 23, 59, 59, 999).getTime();

const total = () => container.querySelector('[data-testid="invoice-total"]')?.textContent;
const alert = () => container.querySelector('[role="alert"]');

describe("the live total", () => {
  it("is exact: 3 x 0.1000001 shows 0.3000003", async () => {
    await open();
    expect(total()).toBe("—");

    await fillValid();

    expect(total()).toBe("0.3000003 USDC");
  });

  it("follows every change: a second line, the currency, and a line that stops being valid", async () => {
    await open();
    await fillValid();
    await click("Add line");
    await type(field("Line 2 quantity"), "2");
    await type(field("Line 2 unit price"), "10");
    expect(total()).toBe("20.3000003 USDC");

    await type(field<HTMLSelectElement>("Currency"), "XLM");
    expect(total()).toBe("20.3000003 XLM");

    await type(field("Line 2 quantity"), "1.5");
    expect(total()).toBe("—");

    await click("Remove line 2");
    expect(total()).toBe("0.3000003 XLM");
  });

  it("adds in fixed point, where floats would not", () => {
    expect(liveInvoiceTotal([{ quantity: "3", unitPrice: "0.1000001" }])).toBe("0.3000003");
    expect(
      liveInvoiceTotal([
        { quantity: "1", unitPrice: "0.1" },
        { quantity: "1", unitPrice: "0.2" },
      ]),
    ).toBe("0.3");
    for (const bad of [
      { quantity: "0", unitPrice: "1" },
      { quantity: "-1", unitPrice: "1" },
      { quantity: "1e3", unitPrice: "1" },
      { quantity: "1", unitPrice: "" },
      { quantity: "1", unitPrice: "0" },
      { quantity: "1", unitPrice: "abc" },
    ]) {
      expect(liveInvoiceTotal([bad])).toBeNull();
    }
  });
});

describe("saving a draft", () => {
  it("creates the draft with what was typed, then updates the same draft", async () => {
    const { onSave, onIssue } = await open();
    await fillValid();
    await type(field("Client email (optional)"), "ada@example.test");
    await type(field<HTMLTextAreaElement>("Notes (optional)"), "Net 14");
    await type(field("Due date"), DUE_INPUT);

    await click("Save draft");

    expect(onSave).toHaveBeenCalledTimes(1);
    const [values, id] = onSave.mock.calls[0]!;
    expect(id).toBeNull();
    expect(values).toEqual({
      clientName: "Ada Obi",
      clientEmail: "ada@example.test",
      clientAddress: null,
      notes: "Net 14",
      assetCode: "USDC",
      lineItems: [{ description: "Design work", quantity: 3, unitPrice: "0.1000001" }],
      // The end of that local day.
      dueAt: DUE_AT,
    });
    expect(onIssue).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Draft saved.");
    expect(container.querySelector("h2")?.textContent).toBe("Edit invoice");

    await type(field("Client name"), "Ada Obi Ltd");
    // An edit after saving is not saved yet.
    expect(container.querySelector('[role="status"]')).toBeNull();
    await click("Save draft");

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]![0].clientName).toBe("Ada Obi Ltd");
    expect(onSave.mock.calls[1]![1]).toBe("inv_1");
  });

  it("opens an existing draft with its values and saves it under its id", async () => {
    const draft: Invoice = {
      id: "inv_existing",
      number: null,
      clientName: "Bola Ade",
      clientEmail: "bola@example.test",
      clientAddress: "4 Creek Road",
      lineItems: [
        { description: "Audit", quantity: 2, unitPrice: "150" },
        { description: "Travel", quantity: 1, unitPrice: "20.5" },
      ],
      total: "320.5",
      assetCode: "XLM",
      issuedAt: null,
      dueAt: DUE_AT,
      status: "draft",
      linkId: null,
      notes: "Thanks",
    };
    const { onSave } = await open({ invoice: draft });

    expect(container.querySelector("h2")?.textContent).toBe("Edit invoice");
    expect(field("Client name").value).toBe("Bola Ade");
    expect(field("Client email (optional)").value).toBe("bola@example.test");
    expect(field<HTMLSelectElement>("Currency").value).toBe("XLM");
    expect(field("Due date").value).toBe(DUE_INPUT);
    expect(field("Line 2 description").value).toBe("Travel");
    expect(total()).toBe("320.5 XLM");

    await click("Save draft");
    expect(onSave.mock.calls[0]![1]).toBe("inv_existing");
    expect(onSave.mock.calls[0]![0].lineItems).toEqual(draft.lineItems);
  });

  it.each([
    [async () => {}, /^Client name: /, "no client name"],
    [
      async () => {
        await type(field("Client name"), "Ada");
        await type(field("Line 1 description"), "Work");
      },
      /^Line 1 unit price: /,
      "no unit price",
    ],
    [
      async () => {
        await fillValid();
        await type(field("Line 1 quantity"), "1.5");
      },
      /^Line 1 quantity: /,
      "a fractional quantity",
    ],
    [
      async () => {
        await fillValid();
        await type(field("Client email (optional)"), "not-an-email");
      },
      /^Client email: /,
      "a malformed email",
    ],
    [
      async () => {
        await fillValid();
        await type(field("Due date"), "2001-01-01");
      },
      /^Due date: dueAt must be in the future$/,
      "a due date in the past",
    ],
  ] as [() => Promise<void>, RegExp, string][])("checks with the core schema before the request (%#: %s)", async (arrange, message) => {
    const { onSave } = await open();
    await arrange();

    await click("Save draft");

    expect(alert()?.textContent).toMatch(message);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the message of a save that was refused, and keeps what was typed", async () => {
    await open({
      onSave: async () => {
        throw new InvoiceSheetError("The data sent to the server was invalid. Check your inputs and try again.");
      },
    });
    await fillValid();

    await click("Save draft");

    expect(alert()?.textContent).toBe("The data sent to the server was invalid. Check your inputs and try again.");
    expect(field("Client name").value).toBe("Ada Obi");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("issuing", () => {
  it("saves the draft first, then issues it, then shows the number and the public URL", async () => {
    const order: string[] = [];
    const { onSave, onIssue } = await open({
      onSave: async (values) => {
        order.push("save");
        return invoiceFrom(values, { id: "inv_42" });
      },
      onIssue: async (id) => {
        order.push(`issue ${id}`);
        return { ...invoiceFrom({ clientName: "Ada Obi", assetCode: "USDC", lineItems: [], dueAt: 1 }), id, number: "INV-0042", status: "open" };
      },
    });
    await fillValid();

    await submit();

    expect(order).toEqual(["save", "issue inv_42"]);
    expect(onSave.mock.calls[0]![1]).toBeNull();
    expect(onIssue).toHaveBeenCalledExactlyOnceWith("inv_42");
    expect(container.querySelector("h2")?.textContent).toBe("Invoice INV-0042 is issued");
    expect(container.querySelector(".sharebox code")?.textContent).toBe(`${window.location.origin}/invoice/inv_42`);
    expect(container.querySelector("form")).toBeNull();
  });

  it("copies the public URL", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open({ onSave: async (values) => invoiceFrom(values, { id: "inv_42" }) });
    await fillValid();
    await submit();

    await click("Copy link");

    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/invoice/inv_42`);
    expect(button("Copied")).toBeTruthy();
  });

  it("shows a 422 with its message and trustline link, and the invoice stays a draft", async () => {
    let attempts = 0;
    const { onSave, onIssue } = await open({
      onIssue: async (id) => {
        attempts += 1;
        if (attempts === 1) {
          throw new InvoiceSheetError("Your wallet has no USDC trustline yet.", "web+stellar:tx?xdr=AAAA");
        }
        return { ...invoiceFrom({ clientName: "Ada Obi", assetCode: "USDC", lineItems: [], dueAt: 1 }), id, number: "INV-0001", status: "open" };
      },
    });
    await fillValid();

    await submit();

    expect(alert()?.textContent).toContain("Your wallet has no USDC trustline yet.");
    const link = alert()?.querySelector("a");
    expect(link?.textContent).toBe("Add the trustline");
    expect(link?.getAttribute("href")).toBe("web+stellar:tx?xdr=AAAA");
    // Still the form, on the saved draft, with what was typed.
    expect(container.querySelector("h2")?.textContent).toBe("Edit invoice");
    expect(field("Client name").value).toBe("Ada Obi");

    // Trying again updates that draft and does not create a second one.
    await submit();
    expect(onSave.mock.calls.map(([, id]) => id)).toEqual([null, "inv_1"]);
    expect(onIssue).toHaveBeenCalledTimes(2);
    expect(container.querySelector("h2")?.textContent).toBe("Invoice INV-0001 is issued");
  });

  it("does not issue when the draft could not be saved", async () => {
    const { onIssue } = await open({
      onSave: async () => {
        throw new InvoiceSheetError("Failed to save the invoice. Please try again.");
      },
    });
    await fillValid();

    await submit();

    expect(onIssue).not.toHaveBeenCalled();
    expect(alert()?.textContent).toBe("Failed to save the invoice. Please try again.");
  });
});

describe("keyboard and accessibility", () => {
  it("labels every input", async () => {
    await open();
    await click("Add line");
    const controls = [...container.querySelectorAll<HTMLElement>("input, select, textarea")];
    expect(controls.length).toBe(12);
    for (const control of controls) {
      const label = container.querySelector(`label[for="${control.id}"]`);
      expect([control.id, Boolean(label?.textContent)]).toEqual([control.id, true]);
    }
  });

  it("announces line rows by index and names each remove button", async () => {
    await open();
    await click("Add line");
    await click("Add line");

    expect([...container.querySelectorAll("legend")].map((l) => l.textContent)).toEqual(["Line 1", "Line 2", "Line 3"]);
    expect(button("Remove line 2").getAttribute("aria-label")).toBe("Remove line 2");
    expect(field("Line 3 description")).toBeTruthy();
  });

  it("moves focus to the new row when one is added", async () => {
    await open();
    await click("Add line");
    expect(document.activeElement).toBe(field("Line 2 description"));
    await click("Add line");
    expect(document.activeElement).toBe(field("Line 3 description"));
  });

  it("removes the row that was asked for and renumbers the rest", async () => {
    await open();
    await type(field("Line 1 description"), "first");
    await click("Add line");
    await type(field("Line 2 description"), "second");
    await click("Add line");
    await type(field("Line 3 description"), "third");

    await click("Remove line 2");

    expect(container.querySelectorAll("fieldset")).toHaveLength(2);
    expect(field("Line 1 description").value).toBe("first");
    expect(field("Line 2 description").value).toBe("third");
  });

  it("keeps at least one line and at most fifty", async () => {
    await open();
    expect(button("Remove line 1").disabled).toBe(true);
    for (let i = 1; i < 50; i++) await click("Add line");
    expect(container.querySelectorAll("fieldset")).toHaveLength(50);
    expect(button("Add line").disabled).toBe(true);
    expect(button("Remove line 1").disabled).toBe(false);
  });

  it("closes on Escape when idle, and not while a request is in flight", async () => {
    let release: (invoice: Invoice) => void = () => {};
    const { onClose } = await open({
      onSave: (values) =>
        new Promise<Invoice>((resolve) => {
          release = () => resolve(invoiceFrom(values));
        }),
    });
    const escape = () =>
      act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

    await fillValid();
    await act(async () => {
      button("Save draft").click();
    });
    expect(button("Saving…").disabled).toBe(true);
    await escape();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      release(invoiceFrom({ clientName: "x", assetCode: "USDC", lineItems: [], dueAt: 0 }));
    });
    await settle();
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submits from the keyboard: the form's submit issues the invoice", async () => {
    const { onIssue } = await open();
    await fillValid();
    expect(button("Issue invoice").getAttribute("type")).toBe("submit");
    expect(button("Save draft").getAttribute("type")).toBe("button");
    await submit();
    expect(onIssue).toHaveBeenCalledTimes(1);
  });
});

describe("the Invoices nav item", () => {
  async function navLabels(flag: string | undefined) {
    if (flag === undefined) vi.stubEnv("NEXT_PUBLIC_INVOICES_ENABLED", "");
    else vi.stubEnv("NEXT_PUBLIC_INVOICES_ENABLED", flag);
    vi.resetModules();
    const { default: Shell } = await import("../app/components/dashboard/Shell");
    await act(async () => {
      root.render(
        <Shell view="home" onNavigate={() => {}} onCreate={() => {}}>
          <div />
        </Shell>,
      );
    });
    return [...container.querySelectorAll('nav[aria-label="Dashboard"] button')].map((b) => b.textContent);
  }

  it.each([undefined, "false", "1", "TRUE"])("is absent when NEXT_PUBLIC_INVOICES_ENABLED is %j", async (flag) => {
    expect(await navLabels(flag)).not.toContain("Invoices");
  });

  it('is present, after Payments, when it is "true"', async () => {
    const labels = await navLabels("true");
    expect(labels).toContain("Invoices");
    expect(labels.indexOf("Invoices")).toBe(labels.indexOf("Payments") + 1);
  });
});

describe("the invoice client functions", () => {
  it("call the routes of issue 4.67", async () => {
    const calls: Array<[string, string, unknown]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push([init?.method ?? "GET", new URL(String(input), "http://x").pathname, init?.body ? JSON.parse(String(init.body)) : undefined]);
        return new Response(JSON.stringify({ invoice: { id: "inv_1" } }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const input: InvoiceInput = { clientName: "Ada", assetCode: "USDC", lineItems: [{ description: "x", quantity: 1, unitPrice: "1" }], dueAt: 5 };

    expect((await api.createInvoice(input)).invoice.id).toBe("inv_1");
    await api.updateInvoice("inv_1", { notes: "n" });
    await api.issueInvoice("inv_1");
    await api.getInvoice("inv_1");

    expect(calls).toEqual([
      ["POST", "/invoices", input],
      ["PATCH", "/invoices/inv_1", { notes: "n" }],
      ["POST", "/invoices/inv_1/issue", undefined],
      ["GET", "/invoices/inv_1", undefined],
    ]);
    vi.unstubAllGlobals();
  });
});
