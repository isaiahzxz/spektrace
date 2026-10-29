import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.SPEKTRACE_NEXT_DIST_DIR?.trim() || ".next",
  ...(process.env.SPEKTRACE_NEXT_TSCONFIG ? {typescript:{tsconfigPath:process.env.SPEKTRACE_NEXT_TSCONFIG.replaceAll("\\","/")}} : {}),
  cacheComponents: true,
  partialPrefetching: true,
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
