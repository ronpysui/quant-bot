/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["ccxt", "@vercel/postgres"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Prevent webpack from bundling ccxt — use native Node require at runtime
      const existing = Array.isArray(config.externals) ? config.externals : [];
      config.externals = [...existing, "ccxt"];
    }
    return config;
  },
};

module.exports = nextConfig;
