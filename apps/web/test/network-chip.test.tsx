// @vitest-environment happy-dom
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkChip from "../app/components/NetworkChip";

afterEach(() => vi.unstubAllEnvs());

describe("NetworkChip", () => {
  it("says Mainnet on a mainnet deployment", () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "public");
    const html = renderToString(<NetworkChip />);
    expect(html).toContain("Mainnet");
    expect(html).toContain("netchip--public");
    expect(html).not.toContain("no real money");
  });

  it("says Testnet and that there is no real money on testnet", () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "testnet");
    const html = renderToString(<NetworkChip />);
    expect(html).toContain("Testnet: no real money");
    expect(html).toContain("netchip--testnet");
  });

  it("carries the network in text, not colour alone", () => {
    // The words are inside the element itself, so a screen reader, a greyscale
    // print or a forced-colours mode all still communicate the network.
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "public");
    expect(renderToString(<NetworkChip />)).toMatch(/>Mainnet<\/span>/);
  });
});
