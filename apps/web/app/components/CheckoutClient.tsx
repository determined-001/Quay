"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, type LinkWithRequest, type LinkWithServerTime } from "../../lib/api";

const TERMINAL = new Set([
  "paid",
  "offramp_pending",
  "offramp_settled",
  "offramp_failed",
  "expired",
  "cancelled",
]);

const WARNING_SECONDS = 120; // < 2 minutes remaining → show warning

export default function CheckoutClient({ initial }: { initial: LinkWithRequest }) {
  const { request } = initial;
  const [link, setLink] = useState(initial.link);
  const [serverTimeSkew, setServerTimeSkew] = useState(0); // ms: positive = server ahead
  const expiryRef = useRef<number | null>(null);

  const done = TERMINAL.has(link.status);
  const isActive = link.status === "active";
  const isExpired = link.status === "expired";
  const isCancelled = link.status === "cancelled";
  const isUnderpaid = link.status === "underpaid";
  const hasExpiry = link.expiresAt != null && link.expiresAt > 0;

  /* ── Countdown state ── */
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  // Sync countdown with server-time-corrected clock every 250 ms
  useEffect(() => {
    if (!hasExpiry || done) {
      setRemainingMs(null);
      return;
    }

    expiryRef.current = link.expiresAt;

    const tick = () => {
      if (expiryRef.current == null) return;
      const remaining = expiryRef.current - (Date.now() + serverTimeSkew);
      setRemainingMs(Math.max(0, remaining));
    };

    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [hasExpiry, done, link.expiresAt, serverTimeSkew]);

  /* ── Clock skew correction from initial response ── */
  // We capture the server's Date header from the very first getLink call (the
  // SSR fetch in page.tsx passes the server timestamp through the initial prop).
  // If the initial link was fetched server-side, assume zero skew.
  // The polling fetches will refine the estimate.
  useEffect(() => {
    if (!hasExpiry) return;
    // On mount, fetch a fresh copy of the link with server-time header
    const correctSkew = async () => {
      try {
        const result = await api.getLinkWithServerTime(link.id);
        setLink(result.link);
        if (result.serverDate != null) {
          const clientNow = Date.now();
          const serverNow = result.serverDate.getTime();
          setServerTimeSkew(serverNow - clientNow);
        }
      } catch {
        // Keep existing skew estimate
      }
    };
    void correctSkew();
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Polling ── */
  useEffect(() => {
    if (done) return;
    const poll = async () => {
      try {
        const result = await api.getLinkWithServerTime(link.id);
        setLink(result.link);
        if (result.serverDate != null) {
          const clientNow = Date.now();
          const serverNow = result.serverDate.getTime();
          setServerTimeSkew(serverNow - clientNow);
        }
      } catch {
        /* keep polling */
      }
    };
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [link.id, done]);

  /* ── On expiry, stop polling and switch view ── */
  useEffect(() => {
    if (hasExpiry && remainingMs === 0 && isActive) {
      // The link has just expired on the client. Fetch once more to get the
      // server-confirmed expired status.
      const confirmExpiry = async () => {
        try {
          const result = await api.getLink(link.id);
          setLink(result.link);
        } catch {
          // If the fetch fails, optimistically show expired state.
          setLink((prev) => ({ ...prev, status: "expired" as const }));
        }
      };
      void confirmExpiry();
    }
  }, [remainingMs, hasExpiry, isActive, link.id]);

  const warningActive =
    hasExpiry && remainingMs != null && remainingMs > 0 && remainingMs < WARNING_SECONDS * 1000;
  const timeLeft = hasExpiry && remainingMs != null ? formatCountdown(remainingMs) : null;

  /* ── Render ── */

  // Terminal: expired
  if (isExpired) {
    return (
      <div className="checkout">
        <div className="terminal-icon terminal-icon--expired" aria-hidden>!<\/div>
        <div className="settled" style={{ color: "var(--red)" }}>Link expired<\/div>
        <p className="muted" style={{ marginTop: 8 }}>
          This payment link was not paid before it expired.
        <\/p>
        <div className="recovery-actions" style={{ marginTop: 24 }}>
          <a className="btn btn--primary btn--block" href="/">
            Request a new link
          <\/a>
        <\/div>
      <\/div>
    );
  }

  // Terminal: cancelled
  if (isCancelled) {
    return (
      <div className="checkout">
        <div className="terminal-icon terminal-icon--cancelled" aria-hidden>✕<\/div>
        <div className="settled" style={{ color: "var(--red)" }}>Payment cancelled<\/div>
        <p className="muted" style={{ marginTop: 8 }}>
          The seller has cancelled this payment link. Please contact them for a new link.
        <\/p>
        <div className="recovery-actions" style={{ marginTop: 24 }}>
          <a className="btn btn--ghost btn--block" href="/">
            Back to dashboard
          <\/a>
        <\/div>
      <\/div>
    );
  }

  // Terminal: underpaid
  if (isUnderpaid) {
    const outstanding = (
      Number(link.amount) - Number(link.paidAmount ?? 0)
    ).toFixed(2);
    return (
      <div className="checkout">
        <div className="terminal-icon terminal-icon--underpaid" aria-hidden>!<\/div>
        <div className="settled" style={{ color: "var(--amber)" }}>Underpaid<\/div>
        <p className="muted" style={{ marginTop: 8 }}>
          A payment arrived for less than the requested amount.
        <\/p>
        <div className="amount-hero" style={{ fontSize: 28, marginTop: 16 }}>
          {outstanding}
          <span className="asset">{link.asset.code}<\/span>
        <\/div>
        <p className="muted" style={{ fontSize: 12 }}>Still outstanding<\/p>
        {request && (
          <>
            <div className="qr-wrap">
              <QRCodeSVG value={request.uri} size={180} fgColor="#0b0f14" bgColor="#ffffff" level="M" />
            <\/div>
            <a className="btn btn--primary btn--block" href={request.uri} style={{ marginTop: 12 }}>
              Pay remaining
            <\/a>
          <\/>
        )}
      <\/div>
    );
  }

  // Settled (paid, offramp_*)
  if (done) {
    return (
      <div className="checkout">
        <div className="settled-check" aria-hidden>✓<\/div>
        <div className="settled">Payment received<\/div>
        <p className="muted" style={{ marginTop: 8 }}>
          {link.paidAmount ?? link.amount} {link.asset.code} settled to the merchant.
        <\/p>
        <div className="memo-note" style={{ marginTop: 24 }}>
          <div className="k">Transaction<\/div>
          <div className="v">{link.txHash ?? "confirmed on-chain"}<\/div>
        <\/div>
      <\/div>
    );
  }

  // Active: show QR, countdown, and memo
  return (
    <div className="checkout">
      {/* Countdown timer */}
      {timeLeft && (
        <div
          className={`countdown ${warningActive ? "countdown--warning" : ""}`}
          role="timer"
          aria-live="polite"
          aria-label={`Time remaining: ${timeLeft}`}
        >
          {warningActive && (
            <span className="countdown-warning-label" role="alert">
              expires soon
            <\/span>
          )}
          <span className="countdown-value">{timeLeft}<\/span>
        <\/div>
      )}

      <div className="merchant">Pay merchant<\/div>
      <p className="title">{link.title}<\/p>

      <div className="amount-hero">
        {link.amount}
        <span className="asset">{link.asset.code}<\/span>
      <\/div>

      <div className="qr-wrap">
        <QRCodeSVG value={request.uri} size={180} fgColor="#0b0f14" bgColor="#ffffff" level="M" />
      <\/div>
      <p className="muted" style={{ fontSize: 13 }}>
