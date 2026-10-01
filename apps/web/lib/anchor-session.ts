"use client";

import { useCallback, useState } from "react";
import { api, CheckoutError, describeError, type AnchorAuthView, type PaymentLink } from "./api";
import { signTransaction } from "./wallet";

export const EXPIRATION_WARNING_MS = 15 * 60_000;

export interface AnchorReconnectBannerState {
  show: boolean;
  isExpired: boolean;
  isExpiringSoon: boolean;
  affectedCount: number;
  anchorName: string;
  expiresAt: number | null;
}

/**
 * Pure decision logic for whether the anchor reconnect / renewal banner should be displayed.
 */
export function shouldShowAnchorReconnectBanner({
  anchorAuth,
  links,
  offrampEnabled = true,
  isMock = false,
  now = Date.now(),
}: {
  anchorAuth: AnchorAuthView | null;
  links: PaymentLink[];
  offrampEnabled?: boolean;
  isMock?: boolean;
  now?: number;
}): AnchorReconnectBannerState {
  const fallbackAnchor = anchorAuth?.anchor ?? "the anchor";
  if (!offrampEnabled || isMock || !anchorAuth?.required) {
    return {
      show: false,
      isExpired: false,
      isExpiringSoon: false,
      affectedCount: 0,
      anchorName: fallbackAnchor,
      expiresAt: anchorAuth?.expiresAt ?? null,
    };
  }

  const affectedCount = links.filter((l) => l.status === "offramp_pending").length;
  if (affectedCount === 0) {
    return {
      show: false,
      isExpired: false,
      isExpiringSoon: false,
      affectedCount: 0,
      anchorName: fallbackAnchor,
      expiresAt: anchorAuth.expiresAt,
    };
  }

  const isExpired =
    !anchorAuth.connected ||
    (anchorAuth.expiresAt !== null && now >= anchorAuth.expiresAt);

  const isExpiringSoon =
    !isExpired &&
    anchorAuth.connected &&
    anchorAuth.expiresAt !== null &&
    anchorAuth.expiresAt - now <= EXPIRATION_WARNING_MS &&
    anchorAuth.expiresAt - now > 0;

  return {
    show: isExpired || isExpiringSoon,
    isExpired,
    isExpiringSoon,
    affectedCount,
    anchorName: fallbackAnchor,
    expiresAt: anchorAuth.expiresAt,
  };
}

/**
 * Determines whether a link row should show the "waiting for you to reconnect" hint
 * instead of the generic pending pill.
 */
export function shouldShowReconnectHint(
  link: PaymentLink,
  anchorAuth: AnchorAuthView | null,
  options?: { offrampEnabled?: boolean; isMock?: boolean; now?: number },
): boolean {
  const offrampEnabled = options?.offrampEnabled ?? true;
  const isMock = options?.isMock ?? false;
  if (!offrampEnabled || isMock || !anchorAuth?.required) return false;
  if (link.status !== "offramp_pending") return false;

  const now = options?.now ?? Date.now();
  const isDisconnectedOrExpired =
    !anchorAuth.connected ||
    (anchorAuth.expiresAt !== null && now >= anchorAuth.expiresAt);

  return isDisconnectedOrExpired;
}

/**
 * Computes timeout delay to schedule a re-check at expiresAt (+ marginMs).
 */
export function calculateAnchorRecheckDelay(
  expiresAt: number | null,
  now = Date.now(),
  marginMs = 1000,
): number | null {
  if (expiresAt === null) return null;
  const delay = expiresAt - now + marginMs;
  return Math.max(0, delay);
}

/**
 * Shared hook for connecting/authenticating to the anchor via SEP-10 challenge-sign flow.
 */
export function useAnchorConnect(options?: {
  wallet?: string | null;
  onSuccess?: () => void;
}) {
  const wallet = options?.wallet ?? null;
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectAnchor = useCallback(async () => {
    if (!wallet) return;
    setError(null);
    setConnecting(true);
    try {
      const { transaction } = await api.getAnchorChallenge();
      const signed = await signTransaction(transaction, wallet);
      await api.completeAnchorAuth(signed);
      options?.onSuccess?.();
    } catch (e) {
      if (e instanceof CheckoutError) {
        setError(describeError(e));
      } else {
        setError("Signing was cancelled or the wallet is unavailable.");
      }
    } finally {
      setConnecting(false);
    }
  }, [wallet, options]);

  return {
    connecting,
    error,
    setError,
    connectAnchor,
    hasWallet: Boolean(wallet),
  };
}
