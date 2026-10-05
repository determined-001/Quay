/** Load lifecycle of the identity panel's data (anchor session + KYC record). */
export type KycLoadState = "idle" | "loading" | "ready" | "error";

/** Which non-form branch the panel shows while its data is not usable. */
export type KycPanelStage = "connect" | "loading" | "error" | "content";

export function kycPanelStage(input: {
  anchorNeedsConnect: boolean;
  state: KycLoadState;
  hasKyc: boolean;
}): KycPanelStage {
  if (input.anchorNeedsConnect) return "connect";
  // Keep showing a record we already have if a background refresh fails.
  if (input.hasKyc) return "content";
  return input.state === "error" ? "error" : "loading";
}
