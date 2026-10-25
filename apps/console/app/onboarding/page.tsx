import type { Metadata } from "next";
import { OnboardingPage } from "./onboarding-page";

export const metadata: Metadata = { title: "Set up · Toru", robots: { index: false, follow: false } };
export default function Page() { return <OnboardingPage />; }
