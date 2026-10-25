"use client";
import { SignInButton, SignUpButton, useAuth, useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { OnboardingFlow } from "../onboarding-flow";
import { ToruLoading } from "../public-landing";
import { ToruOrb } from "../toru-orb";

/** Signed-in setup. Completion (or a skip) is stored on the Clerk account so it shows once per account, on any device. */
export function OnboardingPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [mode, setMode] = useState<"setup" | "new">("setup");
  useEffect(() => { if (new URLSearchParams(window.location.search).get("from") === "demos") setMode("new"); }, []);
  if (!isLoaded) return <ToruLoading />;
  if (!isSignedIn) return <div className="public-site lw-site st-site"><div className="lw-container"><header className="st-nav"><a className="st-brand" href="https://toru.tools" aria-label="Toru home"><ToruOrb size={22} still />toru</a></header></div><main className="app-signin"><h1>Sign in to set up Toru</h1><SignInButton mode="modal"><button className="primary">Sign in</button></SignInButton><SignUpButton mode="modal"><button className="quiet">Create an account</button></SignUpButton></main></div>;
  async function finish() {
    if (user && !user.unsafeMetadata?.onboardedAt) {
      await user.update({ unsafeMetadata: { ...user.unsafeMetadata, onboardedAt: new Date().toISOString() } }).catch(() => undefined);
    }
    window.location.assign("/#demos");
  }
  return <OnboardingFlow key={mode} mode={mode} onFinish={finish} />;
}
