/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
  webpack: (config, { webpack }) => {
    // wagmi's Coinbase Smart Wallet connector (pulled in transitively by
    // @reown/appkit-adapter-wagmi's bundled @wagmi/connectors) drags in
    // @coinbase/cdp-sdk, which optionally imports `@x402/*` payment
    // packages we don't use and don't have installed — that's an unrelated
    // payments feature of the Coinbase SDK, not anything wallet-connect
    // related, but webpack tries to statically resolve it anyway and fails
    // the build. Ignoring the module path is safe: that code path never
    // executes for CLAIMGAME (we don't use x402 payments). Uses the
    // `webpack` instance Next.js passes in here, not a separately
    // installed `webpack` package — those are different bundled versions
    // and mixing them crashes Next's compiler.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
