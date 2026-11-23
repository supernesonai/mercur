// POST /api/consumer/code — the consumer login rail, step 1 (19-4).
//
// The marketplace has no email/password accounts: a consumer logs in
// through the phone rail (18-6) the platform bridge owns. Step 1 asks
// the bridge for the one-time code; step 2 (/api/consumer/login)
// verifies it and exchanges the resulting OpenIM token for the
// marketplace customer JWT (19-3), which becomes the session cookie.
//
// Staging runs the mock rail: the bridge returns the code in the
// response (a real deployment would SMS it and return nothing).
import { NextResponse } from 'next/server'

// Mirrors the bridge's phoneRe (and the marketplace provider's mirror).
const PHONE_RE = /^\+?[1-9]\d{6,14}$/

export async function POST(req: Request) {
  const bridgeUrl = process.env.BRIDGE_URL
  if (!bridgeUrl) {
    return NextResponse.json(
      { error: 'login rail not configured' },
      { status: 503 }
    )
  }

  let body: { phone?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: 'body must be a JSON object' },
      { status: 400 }
    )
  }
  if (!body.phone || !PHONE_RE.test(body.phone)) {
    return NextResponse.json(
      { error: 'phone must be a valid number' },
      { status: 400 }
    )
  }

  let res: Response
  try {
    res = await fetch(`${bridgeUrl}/api/v1/pwa/register/phone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: body.phone })
    })
  } catch {
    return NextResponse.json(
      { error: 'login rail unreachable' },
      { status: 502 }
    )
  }
  if (!res.ok) {
    return NextResponse.json(
      { error: 'code request failed' },
      { status: 400 }
    )
  }
  const out = (await res.json()) as { phone: string; mockCode: string }

  // mockCode is the staging rail (the bridge's mock returns it); on a
  // real SMS deployment this field is simply absent.
  return NextResponse.json({ phone: out.phone, mockCode: out.mockCode })
}
