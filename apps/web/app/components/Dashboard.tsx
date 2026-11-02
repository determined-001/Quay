"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  CheckoutError,
  describeError,
  type AnchorAuthView,
  type KycView,
  type KycDisclosure,
  type PaymentLink,
  type UsdcTrustlineStatus,
} from "../../lib/api";
import {
  calculateAnchorRecheckDelay,
  shouldShowAnchorReconnectBanner,
  useAnchorConnect,
} from "../../lib/anchor-session";
import type { PaymentFilter } from "../../lib/dashboard-metrics";
import type { KycLoadState } from "../../lib/kyc-load";
import KycPanel from "./KycPanel";
import RegistrationForm from "./RegistrationForm";
import DisclosuresPanel from "./DisclosuresPanel";
import CashOutModal from "./CashOutModal";
import { PendingTransferModal } from "./TransferStep";
import { useSellerWallet } from "./SessionGate";
import Alerts from "./dashboard/Alerts";
import CashOutView from "./dashboard/CashOutView";
import { OFFRAMP_CURRENCY, OFFRAMP_ENABLED, OFFRAMP_IS_MOCK } from "./dashboard/config";
import CreateLinkSheet, { type NewLink } from "./dashboard/CreateLinkSheet";
import DevelopersView from "./dashboard/DevelopersView";
import HomeView from "./dashboard/HomeView";
import PaymentsView from "./dashboard/PaymentsView";
import SettingsView from "./dashboard/SettingsView";
import Shell, { type View } from "./dashboard/Shell";

const VIEWS: readonly View[] = ["home", "payments", "cashout", "settings", "developers"];

/** The view named by the URL fragment, so a refresh or the back button lands where you were. */
function viewFromHash(): View {
  if (typeof window === "undefined") return "home";
  const h = window.location.hash.replace(/^#/, "");
  return (VIEWS as readonly string[]).includes(h) ? (h as View) : "home";
}

/**
 * The seller's dashboard. This component owns the data and the long-running
 * work (polling links, the KYC and anchor-session checks, the cash-out dialogs)
 * and hands what to draw to the views under `./dashboard`.
 */
export default function Dashboard() {
  const wallet = useSellerWallet();
  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [copied, setCopied] = useState<string | null>(null);
  const [trustline, setTrustline] = useState<UsdcTrustlineStatus | null>(null);
  const [kyc, setKyc] = useState<KycView | null>(null);
  const [disclosures, setDisclosures] = useState<KycDisclosure[]>([]);
  const [disclosuresLoading, setDisclosuresLoading] = useState(true);
  const [disclosuresError, setDisclosuresError] = useState<string | null>(null);
  const [disclosureAction, setDisclosureAction] = useState<string | null>(null);
  const [anchorAuth, setAnchorAuth] = useState<AnchorAuthView | null>(null);
  const [kycState, setKycState] = useState<KycLoadState>("idle");
  const [kycError, setKycError] = useState<string | null>(null);
  // Which link has the cash-out modal open; null = closed (issue #32).
  const [cashOutLinkId, setCashOutLinkId] = useState<string | null>(null);
  // Which pending link has the resume-transfer dialog open.
  const [pendingTransferLinkId, setPendingTransferLinkId] = useState<string | null>(null);

  const [view, setView] = useState<View>("home");
  // The Developers area is mounted the first time it is opened and kept after,
  // so an API key shown once at creation survives a trip to another page.
  const [developersOpened, setDevelopersOpened] = useState(false);
  const [paymentsFilter, setPaymentsFilter] = useState<PaymentFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  // Drives "5 min ago" labels; refreshed on a slow timer, not on every poll.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const apply = () => {
      const v = viewFromHash();
      setView(v);
      if (v === "developers") setDevelopersOpened(true);
    };
    apply();
    window.addEventListener("hashchange", apply);
    window.addEventListener("popstate", apply);
    return () => {
      window.removeEventListener("hashchange", apply);
      window.removeEventListener("popstate", apply);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const navigate = useCallback((next: View) => {
    setView(next);
    if (next === "developers") setDevelopersOpened(true);
    if (typeof window !== "undefined") {
      if (window.location.hash !== `#${next}`) window.history.pushState(null, "", `#${next}`);
      window.scrollTo?.({ top: 0 });
      document.getElementById("app-main")?.focus({ preventScroll: true });
    }
  }, []);

  const openPayments = useCallback(
    (filter: PaymentFilter) => {
      setPaymentsFilter(filter);
      navigate("payments");
    },
    [navigate],
  );

  const refresh = useCallback(async () => {
    try {
      const { links: fresh } = await api.listLinks();
      setLinks(fresh);
      setFetchError(null);
    } catch (e) {
      if (e instanceof CheckoutError && e.code === "anchor_auth_required") {
        setAnchorAuth((prev) => (prev ? { ...prev, connected: false } : prev));
      }
      const msg =
        e instanceof CheckoutError
          ? describeError(e)
          : "Failed to load links. Please try again.";
      // If we already have data, keep showing it with a banner on top.
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshKyc = useCallback(async () => {
    if (OFFRAMP_IS_MOCK || !OFFRAMP_ENABLED) return; // no real anchor, nothing to verify
    setKycState("loading");
    setKycError(null);
    try {
      // KYC lives at the anchor under the seller's own account, so it can only
      // be read once the seller's wallet has signed in there.
      const session = await api.getAnchorAuth();
      setAnchorAuth(session);
      if (session.required && !session.connected) {
        setKycState("ready"); // the panel shows "Connect to anchor"
        return;
      }
      setKyc(await api.getKyc());
      setKycState("ready");
    } catch (e) {
      if (e instanceof CheckoutError && e.code === "anchor_auth_required") {
        setAnchorAuth((prev) => (prev ? { ...prev, connected: false } : prev));
        setKycState("ready");
        return;
      }
      // The dashboard still works without it; the cash-out button just stays
      // gated. Surface the failure in the panel so the seller can retry.
      setKycError(
        e instanceof CheckoutError ? describeError(e) : "Could not load identity verification. Please try again.",
      );
      setKycState("error");
    }
  }, []);

  const refreshDisclosures = useCallback(async () => {
    if (OFFRAMP_IS_MOCK || !OFFRAMP_ENABLED) return;
    setDisclosuresLoading(true);
    try {
      setDisclosures(await api.getDisclosures());
      setDisclosuresError(null);
    } catch (e) {
      setDisclosuresError(e instanceof CheckoutError ? describeError(e) : "Could not load disclosure history.");
    } finally {
      setDisclosuresLoading(false);
    }
  }, []);

  const revokeDisclosure = useCallback(async (anchorDomain: string) => {
    setDisclosureAction(anchorDomain);
    setDisclosuresError(null);
    try {
      await api.revokeKycConsent(anchorDomain);
      await refreshDisclosures();
    } catch (e) {
      setDisclosuresError(e instanceof CheckoutError ? describeError(e) : "Could not revoke consent.");
    } finally {
      setDisclosureAction(null);
    }
  }, [refreshDisclosures]);

  const deleteDisclosure = useCallback(async (anchorDomain: string) => {
    if (!window.confirm(`Ask ${anchorDomain} to delete your identity data? This also removes Quay's KYC copy for that anchor.`)) return;
    setDisclosureAction(anchorDomain);
    setDisclosuresError(null);
    try {
      await api.deleteAnchorKyc(anchorDomain);
      await refreshDisclosures();
      void refreshKyc();
    } catch (e) {
      setDisclosuresError(e instanceof CheckoutError ? describeError(e) : "Could not request deletion from the anchor.");
    } finally {
      setDisclosureAction(null);
    }
  }, [refreshDisclosures, refreshKyc]);

  const refreshTrustline = useCallback(async () => {
    try {
      const health = await api.health();
      setTrustline(health.usdcTrustline);
    } catch {
      // Health check itself failing is surfaced by the rest of the dashboard
      // (links won't load either) — don't also blank out a banner that was
      // showing real, still-relevant information.
    }
  }, []);

  const reconnectBanner = shouldShowAnchorReconnectBanner({
    anchorAuth,
    links,
    offrampEnabled: OFFRAMP_ENABLED,
    isMock: OFFRAMP_IS_MOCK,
  });

  const {
    connecting: reconnecting,
    error: reconnectError,
    connectAnchor: handleReconnect,
  } = useAnchorConnect({
    wallet,
    onSuccess: () => {
      void refreshKyc();
      void refresh();
    },
  });

  // Re-check anchor session when expiresAt arrives (plus small margin)
  useEffect(() => {
    if (!anchorAuth?.expiresAt || !OFFRAMP_ENABLED || OFFRAMP_IS_MOCK) return;
    const delay = calculateAnchorRecheckDelay(anchorAuth.expiresAt);
    if (delay === null) return;
    const timer = setTimeout(() => {
      void refreshKyc();
    }, delay);
    return () => clearTimeout(timer);
  }, [anchorAuth?.expiresAt, refreshKyc]);

  // Re-check on window focus or visibility change
  useEffect(() => {
    const onFocusOrVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refreshKyc();
        void refresh();
      }
    };
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);
    return () => {
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
    };
  }, [refreshKyc, refresh]);

  useEffect(() => {
    void refresh();
    void refreshTrustline();
    const t = setInterval(refresh, 5_000);
    const th = setInterval(refreshTrustline, 15_000);
    return () => {
      clearInterval(t);
      clearInterval(th);
    };
  }, [refresh, refreshTrustline]);

  useEffect(() => {
    void refreshKyc();
  }, [refreshKyc]);

  useEffect(() => {
    void refreshDisclosures();
  }, [refreshDisclosures]);

  async function createLink(values: NewLink): Promise<PaymentLink> {
    try {
      const { link } = await api.createLink(values);
      setLinks((prev) => [link, ...prev]);
      return link;
    } catch (e) {
      if (e instanceof CheckoutError && e.code === "destination_cannot_receive") {
        void refreshTrustline(); // don't wait up to 15s for the banner to catch up
      }
      throw new Error(
        e instanceof CheckoutError ? describeError(e) : "Failed to create the payment link. Please try again.",
      );
    }
  }

  async function copyCheckout(id: string) {
    const url = `${window.location.origin}/pay/${id}`;
    await navigator.clipboard.writeText(url);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  }

  /**
   * Cash-out flow (issue #32): the button opens CashOutModal, which fetches the
   * anchor's field descriptors + the seller's masked saved payout fields, then
   * submits through `api.cashOut`. On success the modal closes and we refresh
   * so the link's status flips to off-ramp pending.
   */
  function handleCashOutSuccess() {
    setCashOutLinkId(null);
    void refresh();
  }

  // The link the modal is operating on; null when closed.
  const cashOutLink = cashOutLinkId ? (links.find((l) => l.id === cashOutLinkId) ?? null) : null;

  // Real anchor and not yet verified: never let the seller submit a cash-out
  // that can only fail (or worse, silently carry placeholder identity data).
  const cashOutBlocked = !OFFRAMP_IS_MOCK && kyc?.status !== "ACCEPTED";

  const alerts = (
    <Alerts
      trustline={trustline}
      reconnect={reconnectBanner}
      reconnectError={reconnectError}
      reconnecting={reconnecting}
      onReconnect={handleReconnect}
    />
  );

  const rowActions = {
    copied,
    onCopy: copyCheckout,
    onCashOut: (id: string) => setCashOutLinkId(id),
    onPendingTransfer: (id: string) => setPendingTransferLinkId(id),
    cashOutBlocked,
    anchorAuth,
    now,
  };

  // Identity and consent only matter when a real anchor is on the other end.
  const verification =
    OFFRAMP_ENABLED && !OFFRAMP_IS_MOCK ? (
      <>
        <RegistrationForm />
        <KycPanel
          kyc={kyc}
          anchor={anchorAuth}
          loadState={kycState}
          loadError={kycError}
          onRetry={() => void refreshKyc()}
          onUpdated={(updated) => {
            setKyc(updated);
            void refreshDisclosures();
          }}
          onAnchorConnected={() => void refreshKyc()}
        />
        <DisclosuresPanel
          disclosures={disclosures}
          loading={disclosuresLoading}
          error={disclosuresError}
          deletableAnchorDomain={anchorAuth?.connected ? anchorAuth.anchor : null}
          onRetry={() => void refreshDisclosures()}
          onRevoke={disclosureAction ? undefined : (domain) => void revokeDisclosure(domain)}
          onAskDelete={disclosureAction ? undefined : (domain) => void deleteDisclosure(domain)}
        />
      </>
    ) : null;

  return (
    <>
      <Shell view={view} onNavigate={navigate} onCreate={() => setCreateOpen(true)}>
        {view === "home" && (
          <HomeView
            links={links}
            loading={loading}
            fetchError={fetchError}
            onRetry={refresh}
            trustline={trustline}
            kyc={kyc}
            now={now}
            alerts={alerts}
            onNavigate={navigate}
            onOpenPayments={openPayments}
            onCreate={() => setCreateOpen(true)}
          />
        )}

        {view === "payments" && (
          <PaymentsView
            links={links}
            loading={loading}
            fetchError={fetchError}
            onRetry={refresh}
            filter={paymentsFilter}
            onFilter={setPaymentsFilter}
            alerts={alerts}
            onCreate={() => setCreateOpen(true)}
            {...rowActions}
          />
        )}

        {view === "cashout" && (
          <CashOutView links={links} loading={loading} alerts={alerts} verification={verification} {...rowActions} />
        )}

        {view === "settings" && <SettingsView onNavigate={navigate} />}

        {developersOpened && (
          <div hidden={view !== "developers"}>
            <DevelopersView />
          </div>
        )}
      </Shell>

      {createOpen && <CreateLinkSheet onClose={() => setCreateOpen(false)} onSubmit={createLink} />}

      {/* Cash-out modal, opened from a link's "Cash out" button */}
      {OFFRAMP_ENABLED && cashOutLinkId && cashOutLink && (
        <CashOutModal
          linkId={cashOutLinkId}
          linkAmount={cashOutLink.paidAmount ?? cashOutLink.amount}
          assetCode={cashOutLink.asset.code}
          targetCurrency={OFFRAMP_CURRENCY}
          isMock={OFFRAMP_IS_MOCK}
          onClose={() => setCashOutLinkId(null)}
          onSuccess={handleCashOutSuccess}
        />
      )}

      {/* Resume an unsent cash-out transfer */}
      {OFFRAMP_ENABLED && pendingTransferLinkId && (
        <PendingTransferModal
          linkId={pendingTransferLinkId}
          onClose={() => {
            setPendingTransferLinkId(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}
