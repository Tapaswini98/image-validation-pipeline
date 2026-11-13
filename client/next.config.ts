import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone", // self-contained server for the Docker image
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
