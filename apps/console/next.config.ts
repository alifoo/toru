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

const nextConfig: NextConfig = { reactStrictMode: true };
export default nextConfig;
