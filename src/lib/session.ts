import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { getUserBySession, type User } from './users'

export const SESSION_COOKIE = 'jara_session'

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return token ? getUserBySession(token) : null
}

export async function requireUser(): Promise<User | NextResponse> {
  const user = await currentUser()
  return user ?? NextResponse.json({ error: 'Not signed in' }, { status: 401 })
}

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
}
