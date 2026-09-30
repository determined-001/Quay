import { describe, it, expect } from "vitest";
import {
  shouldShowAnchorReconnectBanner,
  shouldShowReconnectHint,
  calculateAnchorRecheckDelay,
  EXPIRATION_WARNING_MS,
} from "../lib/anchor-session";
import type { AnchorAuthView, PaymentLink } from "../lib/api";

function mockLink(id: string, status: string): PaymentLink {
  return {
    id,
    reference: `ref_${id}`,
    sellerId: "seller_1",
    destination: "GBBD...",
    muxedId: null,
    title: "Test Link",
    amount: "10.00",
    asset: { code: "USDC", issuer: "GBBD..." },
    status: status as any,
    txHash: null,
    payer: null,
    paidAmount: null,
    overpaidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    offrampIndicativeRate: null,
    offrampRate: null,
    offrampRateDelta: null,
    offrampFeeAmount: null,
    offrampFeeCurrency: null,
    offrampFeeSource: null,
    offrampNetTargetAmount: null,
    expiresAt: null,
    isDemo: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("anchor-session logic (issue 5.14)", () => {
  const NOW = 1_700_000_000_000;

  const mockAnchorAuth: AnchorAuthView = {
    required: true,
    connected: false,
    anchor: "TestAnchor",
    expiresAt: null,
  };

  describe("shouldShowAnchorReconnectBanner", () => {
    it("returns show: false when offramp is disabled (none mode)", () => {
      const links = [mockLink("1", "offramp_pending")];
      const res = shouldShowAnchorReconnectBanner({
        anchorAuth: mockAnchorAuth,
        links,
        offrampEnabled: false,
        isMock: false,
        now: NOW,
      });
      expect(res.show).toBe(false);
    });

    it("returns show: false when offramp is mock", () => {
      const links = [mockLink("1", "offramp_pending")];
      const res = shouldShowAnchorReconnectBanner({
        anchorAuth: mockAnchorAuth,
        links,
        offrampEnabled: true,
        isMock: true,
        now: NOW,
      });
      expect(res.show).toBe(false);
    });

    it("returns show: false when anchor is not required", () => {
      const links = [mockLink("1", "offramp_pending")];
      const res = shouldShowAnchorReconnectBanner({
        anchorAuth: { required: false, connected: false, anchor: null, expiresAt: null },
        links,
        offrampEnabled: true,
        isMock: false,
        now: NOW,
      });
      expect(res.show).toBe(false);
    });

    it("returns show: false when there are no offramp_pending links", () => {
      const links = [mockLink("1", "paid"), mockLink("2", "active")];
      const res = shouldShowAnchorReconnectBanner({
        anchorAuth: mockAnchorAuth,
        links,
        offrampEnabled: true,
        isMock: false,
        now: NOW,
      });
      expect(res.show).toBe(false);
      expect(res.affectedCount).toBe(0);
    });

    it("returns show: true and isExpired: true when session is disconnected and links are pending", () => {
      const links = [
        mockLink("1", "offramp_pending"),
        mockLink("2", "offramp_pending"),
        mockLink("3", "paid"),
      ];
      const res = shouldShowAnchorReconnectBanner({
        anchorAuth: {
          required: true,
          connected: false,
          anchor: "Cowrie",
          expiresAt: null,
        },
        links,
        offrampEnabled: true,
        isMock: false,
        now: NOW,
      });
      expect(res.show).toBe(true);
      expect(res.isExpired).toBe(true);
      expect(res.isExpiringSoon).toBe(false);
      expect(res.affectedCount).toBe(2);
      expect(res.anchorName).toBe("Cowrie");
    });

    it("returns show: true and isExpired: true when session was connected but expiresAt is in the past", () => {
      const links = [mockLink("1", "offramp_pending")];
      const res = shouldShowAnchorReconnectBanner({
        anchorAuth: {
          required: true,
          connected: true,
          anchor: "Cowrie",
          expiresAt: NOW - 5000,
        },
        links,
        offrampEnabled: true,
        isMock: false,
        now: NOW,
      });
      expect(res.show).toBe(true);
      expect(res.isExpired).toBe(true);
      expect(res.isExpiringSoon).toBe(false);
      expect(res.affectedCount).toBe(1);
    });

    it("returns show: true and isExpiringSoon: true when expiresAt is within 15 minutes", () => {
      const links = [mockLink("1", "offramp_pending")];
      const res = shouldShowAnchorReconnectBanner({
        anchorAuth: {
          required: true,
          connected: true,
          anchor: "Cowrie",
          expiresAt: NOW + 10 * 60_000, // 10 minutes from now
        },
        links,
        offrampEnabled: true,
        isMock: false,
        now: NOW,
      });
      expect(res.show).toBe(true);
      expect(res.isExpired).toBe(false);
      expect(res.isExpiringSoon).toBe(true);
      expect(res.affectedCount).toBe(1);
    });

    it("returns show: false when session is valid and well beyond 15 minutes", () => {
      const links = [mockLink("1", "offramp_pending")];
      const res = shouldShowAnchorReconnectBanner({
        anchorAuth: {
          required: true,
          connected: true,
          anchor: "Cowrie",
          expiresAt: NOW + 60 * 60_000, // 1 hour from now
        },
        links,
        offrampEnabled: true,
        isMock: false,
        now: NOW,
      });
      expect(res.show).toBe(false);
      expect(res.isExpired).toBe(false);
      expect(res.isExpiringSoon).toBe(false);
    });
  });

  describe("shouldShowReconnectHint", () => {
    it("returns true for offramp_pending link when anchor session is disconnected", () => {
      const link = mockLink("1", "offramp_pending");
      const res = shouldShowReconnectHint(
        link,
        { required: true, connected: false, anchor: "Cowrie", expiresAt: null },
        { offrampEnabled: true, isMock: false, now: NOW },
      );
      expect(res).toBe(true);
    });

    it("returns true for offramp_pending link when anchor session is expired by clock", () => {
      const link = mockLink("1", "offramp_pending");
      const res = shouldShowReconnectHint(
        link,
        { required: true, connected: true, anchor: "Cowrie", expiresAt: NOW - 1000 },
        { offrampEnabled: true, isMock: false, now: NOW },
      );
      expect(res).toBe(true);
    });

    it("returns false for non-pending status even if session expired", () => {
      const link = mockLink("1", "paid");
      const res = shouldShowReconnectHint(
        link,
        { required: true, connected: false, anchor: "Cowrie", expiresAt: null },
        { offrampEnabled: true, isMock: false, now: NOW },
      );
      expect(res).toBe(false);
    });

    it("returns false when session is active and connected", () => {
      const link = mockLink("1", "offramp_pending");
      const res = shouldShowReconnectHint(
        link,
        { required: true, connected: true, anchor: "Cowrie", expiresAt: NOW + 3600_000 },
        { offrampEnabled: true, isMock: false, now: NOW },
      );
      expect(res).toBe(false);
    });
  });

  describe("calculateAnchorRecheckDelay", () => {
    it("returns null if expiresAt is null", () => {
      expect(calculateAnchorRecheckDelay(null)).toBeNull();
    });

    it("calculates positive delay with margin", () => {
      const expiresAt = NOW + 5000;
      const delay = calculateAnchorRecheckDelay(expiresAt, NOW, 1000);
      expect(delay).toBe(6000);
    });

    it("returns 0 if already expired past the margin", () => {
      const expiresAt = NOW - 5000;
      const delay = calculateAnchorRecheckDelay(expiresAt, NOW, 1000);
      expect(delay).toBe(0);
    });
  });
});
