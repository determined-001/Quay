import { networkLabel, stellarNetwork } from "../../lib/explorer";

/**
 * Which Stellar network this deployment settles on (issue 5.43).
 *
 * The checkout, the dashboard, the link detail and the demo all looked the same
 * whether they were moving real money or testnet USDC. A visitor had no way to
 * tell from the page, so the network is now stated in words next to the asset
 * code — on mainnet quietly, on testnet loudly enough to stop a buyer thinking a
 * demo payment is real. The words are the signal; colour is only a second one,
 * so this still works read aloud, in high contrast, or in greyscale.
 */
export default function NetworkChip({ className }: { className?: string }) {
  const network = stellarNetwork();
  return (
    <span className={`netchip netchip--${network}${className ? ` ${className}` : ""}`}>
      {network === "public" ? networkLabel(network) : "Testnet: no real money"}
    </span>
  );
}
