/** @type {import('next').NextConfig} */

// Security headers.
//
// `frame-ancestors` is the one that needs a decision rather than a default.
// `/pay/:id` is *meant* to be framed: packages/widget mounts it in an iframe on
// the merchant's own site, so `DENY` would delete the product's integration
// story. Everything else — the seller dashboard, the receipt page — has no
// reason to be in anyone's frame, and a dashboard that can be framed is a
// dashboard whose buttons can be clicked by a page overlaying it.
//
// So: the checkout is framable by anyone, and nothing else is. That the
// checkout is open is a real residual risk, and the mitigation is not in this
// file — the transaction the buyer actually signs is rendered by their wallet
// extension, in its own window, outside any frame this app controls. A
// clickjacked click can open the wallet; it cannot make the wallet lie about
// what is being signed.
const BASE_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Nothing here uses a camera, microphone, or location. Say so, so an injected
  // script cannot quietly ask on our behalf.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Two years, preload-eligible. Vercel terminates TLS for every deployment,
  // so there is no plaintext origin this can lock a visitor out of.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig = {
  // Internal packages export TS source; Next compiles them.
  transpilePackages: ["@checkout/core"],

  async headers() {
    return [
      {
        // The embeddable checkout: framable by any merchant that integrates it.
        source: "/pay/:path*",
        headers: [...BASE_HEADERS, { key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
      {
        // Everything else: the dashboard, the receipt, the demo page.
        source: "/((?!pay/).*)",
        headers: [
          ...BASE_HEADERS,
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default nextConfig;
