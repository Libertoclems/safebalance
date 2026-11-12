import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Proof-of-work photos and short videos are uploaded through server actions.
    serverActions: { bodySizeLimit: "16mb" },
  },
};

export default nextConfig;
