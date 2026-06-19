/** @type {import('next').NextConfig} */
const nextConfig = {
  // Internal packages export TS source; Next compiles them.
  transpilePackages: ["@checkout/core"],
};
export default nextConfig;
