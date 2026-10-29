import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    service: "spektrace",
    status: "ok",
    phase: "foundation",
  });
}
