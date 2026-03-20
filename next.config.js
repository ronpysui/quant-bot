/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["ccxt", "@vercel/postgres", "yahoo-finance2"],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Prevent webpack from bundling ccxt/yahoo-finance2 — use native Node require at runtime
      const existing = Array.isArray(config.externals) ? config.externals : [];
      config.externals = [...existing, "ccxt", "yahoo-finance2"];
    }
    return config;
  },
};

module.exports = nextConfig;
