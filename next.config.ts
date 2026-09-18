import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse", "adm-zip", "unpdf"],
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;