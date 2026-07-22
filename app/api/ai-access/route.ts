import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  AI_ACCESS_COOKIE,
  AI_ACCESS_MAX_AGE,
  createAiAccessToken,
  isAiAccessRequired,
  verifyAiAccessToken,
  verifyAiClassPassword,
} from "@/lib/ai-access";
import { assertSameOrigin } from "@/lib/csrf";
import { checkPublicRateLimit } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET() {
  const jar = await cookies();
  return NextResponse.json(
    {
      required: isAiAccessRequired(),
      unlocked: verifyAiAccessToken(jar.get(AI_ACCESS_COOKIE)?.value),
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const rl = await checkPublicRateLimit(req, "ai-unlock", "shared", {
    max: 5,
    windowSeconds: 15 * 60,
    paid: process.env.NODE_ENV === "production",
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: rl.retryAfter },
      { status: 429, headers: NO_STORE },
    );
  }
  let body: { password?: unknown };
  try {
    body = (await req.json()) as { password?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  if (typeof body.password !== "string" || body.password.length > 256 || !verifyAiClassPassword(body.password)) {
    return NextResponse.json({ error: "invalid_password" }, { status: 401, headers: NO_STORE });
  }
  try {
    const response = NextResponse.json({ ok: true, required: isAiAccessRequired() }, { headers: NO_STORE });
    if (isAiAccessRequired()) {
      response.cookies.set(AI_ACCESS_COOKIE, createAiAccessToken(), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: AI_ACCESS_MAX_AGE,
      });
    }
    return response;
  } catch {
    return NextResponse.json({ error: "access_unavailable" }, { status: 503, headers: NO_STORE });
  }
}

export async function DELETE(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set(AI_ACCESS_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
