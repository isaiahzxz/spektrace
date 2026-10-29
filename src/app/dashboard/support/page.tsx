import { redirect, notFound } from "next/navigation";
export default function Page() {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  redirect("/dashboard/settings#runtime");
}
