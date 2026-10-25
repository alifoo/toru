import { notFound } from "next/navigation";
import { PublicLanding } from "../../public-landing";

/** Development-only: the marketing landing, which localhost would otherwise replace with the console. */
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PublicLanding />;
}
