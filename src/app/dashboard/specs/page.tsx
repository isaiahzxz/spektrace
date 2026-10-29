import { redirect, notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import {
  coreCompatibilityHref,
  type RawParams,
} from "@/lib/dashboard/mvp-navigation";
async function Entry({ searchParams }: { searchParams: Promise<RawParams> }) {
  await connection();
  return redirect(coreCompatibilityHref(await searchParams, "specs"));
}
export default function Page(props: { searchParams: Promise<RawParams> }) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return (
    <Suspense fallback={<p className="p-6">Opening integrations…</p>}>
      <Entry {...props} />
    </Suspense>
  );
}
