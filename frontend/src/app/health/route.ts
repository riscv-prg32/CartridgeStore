import { NextResponse } from "next/server";

export function GET(): NextResponse {
  return NextResponse.json({ ok: true, service: "prg32-cartridge-store-next", status: "healthy" });
}
