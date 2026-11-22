"use client";

export function InvoiceActions() {
  function handlePrint() {
    window.print();
  }

  return (
    <div className="invoice-actions">
      <button type="button" className="btn btn--ghost" onClick={handlePrint}>
        🖨️ Print / Save as PDF
      </button>
    </div>
  );
}
