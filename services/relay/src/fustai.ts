import { z } from 'zod'

const envelopeSchema = z.object({
  code: z.number(),
  data: z.object({ biz_code: z.number(), biz_data: z.unknown() }).nullable(),
})
const userSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  email: z.string().max(254).nullish(),
  mobile: z.string().max(32).nullish(),
  id_profile: z.object({ name: z.string().max(80).nullish() }).nullish(),
})

/** Identity proven by a FustAI account access token. */
export interface FustaiUser { id: string; displayName: string }

/**
 * Resolve the FustAI account behind an access token by calling the account
 * center. The relay never stores the token itself: it only keeps the resulting
 * account id, so a stolen relay database cannot be replayed against FustAI.
 *
 * @param origin Account-center origin, e.g. `https://account.fustai.com`.
 * @param token FustAI access token presented by a desktop or mobile client.
 * @returns The account id and the label shown in device lists.
 * @throws Error when the token is rejected or the account center is unreachable.
 */
export async function verifyFustaiToken(origin: string, token: string): Promise<FustaiUser> {
  const response = await fetch(`${origin}/auth-api/v0/users/current`, {
    headers: { 'x-dsh-auth-token': token, accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  })
  if (response.status === 401) throw new Error('FUSTAI_TOKEN_INVALID')
  if (!response.ok) throw new Error(`FUSTAI_UNAVAILABLE_${response.status}`)
  const envelope = envelopeSchema.parse(await response.json())
  if (envelope.code !== 0 || !envelope.data || envelope.data.biz_code !== 0) throw new Error('FUSTAI_TOKEN_INVALID')
  const user = userSchema.parse(envelope.data.biz_data)
  return { id: user.id, displayName: user.id_profile?.name?.trim() || user.email || user.mobile || user.id }
}