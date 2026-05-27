import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export async function GET() {
  const url = process.env.CHANGELOG_URL?.replace(/\/$/, "");
  const clientId = process.env.CHANGELOG_CLIENT_ID;
  const appId = process.env.CHANGELOG_APP_ID;

  if (!url || !clientId || !appId) {
    return NextResponse.json(
      { ok: false, error: "Changelog service no configurado", entries: [] },
      { status: 200 }
    );
  }

  try {
    const res = await fetch(`${url}/api/changelog/${clientId}/${appId}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Upstream ${res.status}`, entries: [] },
        { status: 200 }
      );
    }
    const data = await res.json();
    return NextResponse.json({ ok: true, entries: data.entries ?? [] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e), entries: [] },
      { status: 200 }
    );
  }
}
