// POST /api/consumer/login — the consumer login rail, step 2 (19-4).
//
// Verifies the phone code with the platform bridge, exchanges the
// resulting OpenIM token for the marketplace customer JWT (19-3), and
// sets the Medusa session cookie. The cookie carries the SAME
// attributes the storefront's own setAuthToken uses (lib/data/cookies.
// ts) — including the COOKIE_SECURE opt-in, since staging serves over
// plain HTTP and a Secure cookie there would be dropped by the browser.
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

// Mirrors the bridge's phoneRe (and the marketplace provider's mirror).
const PHONE_RE = /^\+?[1-9]\d{6,14}$/
// Mirrors setAuthToken in lib/data/cookies.ts.
const SESSION_MAX_AGE = 60 * 60 * 24 * 7

export async function POST(req: Request) {
  const bridgeUrl = process.env.BRIDGE_URL
  if (!bridgeUrl) {
    return NextResponse.json(
      { error: 'login rail not configured' },
      { status: 503 }
    )
  }

  let body: { phone?: string; code?: string }
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
  if (!body.code) {
    return NextResponse.json(
      { error: 'code is required' },
      { status: 400 }
    )
  }

  // 1) verify the code -> the consumer's OpenIM gateway token.
  let verifyRes: Response
  try {
    verifyRes = await fetch(`${bridgeUrl}/api/v1/pwa/register/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: body.phone, code: body.code })
    })
  } catch {
    return NextResponse.json(
      { error: 'login rail unreachable' },
      { status: 502 }
    )
  }
  if (!verifyRes.ok) {
    return NextResponse.json(
      { error: 'incorrect or expired code' },
      { status: 400 }
    )
  }
  let imToken = ''
  try {
    ;({ token: imToken } = (await verifyRes.json()) as {
      token: string
      userId: string
    })
  } catch {
    return NextResponse.json(
      { error: 'login rail returned no token' },
      { status: 502 }
    )
  }
  if (!imToken) {
    return NextResponse.json(
      { error: 'login rail returned no token' },
      { status: 502 }
    )
  }

  // 2) exchange the OpenIM token for the marketplace customer JWT.
  // POST-only on the bridge (Go method-prefixed route): a GET falls
  // through to the PWA SPA fallback (HTML), not a 405.
  let exchRes: Response
  try {
    exchRes = await fetch(
      `${bridgeUrl}/api/v1/pwa/marketplace/token`,
      { method: 'POST', headers: { authorization: `Bearer ${imToken}` } }
    )
  } catch {
    return NextResponse.json(
      { error: 'login rail unreachable' },
      { status: 502 }
    )
  }
  if (!exchRes.ok) {
    return NextResponse.json(
      { error: 'marketplace login failed' },
      { status: exchRes.status === 401 ? 401 : 502 }
    )
  }
  let customerJwt = ''
  let customerId = ''
  try {
    ;({ customerJwt, customerId } = (await exchRes.json()) as {
      customerJwt: string
      customerId: string
    })
  } catch {
    return NextResponse.json(
      { error: 'marketplace returned no token' },
      { status: 502 }
    )
  }
  if (!customerJwt) {
    return NextResponse.json(
      { error: 'marketplace returned no token' },
      { status: 502 }
    )
  }

  // 3) the session cookie (same attributes as setAuthToken).
  const jar = await cookies()
  jar.set('_medusa_jwt', customerJwt, {
    maxAge: SESSION_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1'
  })

  return NextResponse.json({ success: true, customerId })
}
