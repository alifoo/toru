import type { NextConfig } from "next";

if (process.env.VERCEL_ENV === "production" &&
    (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith("pk_live_") ||
     !process.env.CLERK_SECRET_KEY?.startsWith("sk_live_"))) {
  throw new Error("production_clerk_instance_required");
}

if (process.env.VERCEL_ENV === "production" &&
    process.env.NEXT_PUBLIC_CREATOR_CHECKOUT_ENABLED === "true" &&
    process.env.RECORDER_CREATOR_CHECKOUT_ENABLED !== "true") {
  throw new Error("production_checkout_backend_required");
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    }];
  },
};
export default nextConfig;
