import { notFound } from "next/navigation";
import { StudioPreview } from "./preview";

/** Development-only: the signed-in console rendered with sample runs, for visual checks without an account. */
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <StudioPreview />;
}
