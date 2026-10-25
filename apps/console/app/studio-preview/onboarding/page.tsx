import { notFound } from "next/navigation";
import { StudioPreview } from "../preview";

/** Development-only: the onboarding page with stubbed APIs. */
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <StudioPreview />;
}
