import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { accountDeviceDescriptorSchema, type AccountDeviceDescriptor } from './protocol/index.js'
import { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const secret = (): string => randomBytes(32).toString('base64url')
export const equal = (left: string, right: string): boolean => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)))
const tokenSchema = z.object({
  kind: z.enum(['access', 'refresh']), accountId: z.string(), deviceId: z.string(), expires: z.number(), used: z.boolean(),
  recovery: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), accessExpires: z.number().int().positive() }).optional(),
})
const savedDeviceSchema = z.object({ descriptor: accountDeviceDescriptorSchema, revoked: z.boolean(), lastSeenAt: z.number() })
const accountSchema = z.object({ displayName: z.string(), devices: z.record(z.string(), savedDeviceSchema) })
const stateSchema = z.object({
  version: z.literal(2),
  accounts: z.record(z.string(), accountSchema),
  tokens: z.record(z.string(), tokenSchema),
})
type SavedDevice = z.infer<typeof savedDeviceSchema>
type SavedToken = z.infer<typeof tokenSchema>
/** A device authenticated by a bearer token, together with the account that owns it. */
export type AuthenticatedDevice = SavedDevice & { accountId: string }

// Domain-separated HMACs keyed by the presented bearer, NOT its stored digest.
// The nonce alone cannot recover credentials from a copy of state.json.
function successor(token: string, nonce: string, deviceId: string) {
  const derive = (kind: string) => createHmac('sha256', token)
    .update(JSON.stringify(['ds-harness-remote/refresh/v1', deviceId, nonce, kind])).digest('base64url')
  return { accessToken: derive('access'), refreshToken: derive('refresh') }
}

/**
 * Single-process, multi-tenant store. Devices and credentials are partitioned by
 * the FustAI account id that authenticated the registration; only token digests
 * and public identities reach disk.
 */
export class Store {
  private state: z.infer<typeof stateSchema>
  onInvalidate: (accountId: string, deviceId: string) => void = () => {}
  constructor(private readonly file: string) {
    this.state = existsSync(file) ? stateSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { version: 2, accounts: {}, tokens: {} }
    this.save()
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  private devices(accountId: string): Record<string, SavedDevice> {
    const account = this.state.accounts[accountId]
    if (!account) throw new ApiError('DEVICE_NOT_FOUND', 404)
    return account.devices
  }
  /** Record the account the first time a FustAI identity registers a device. */
  ensure(accountId: string, displayName: string): void {
    if (this.state.accounts[accountId]) return
    if (Object.keys(this.state.accounts).length >= 1024) throw new ApiError('RATE_LIMITED', 429)
    this.state.accounts[accountId] = { displayName, devices: {} }
    this.save()
  }
  displayName(accountId: string): string {
    return this.state.accounts[accountId]?.displayName ?? ''
  }
  get(accountId: string, id: string): SavedDevice {
    const devices = this.devices(accountId)
    const d = Object.hasOwn(devices, id) ? devices[id] : undefined
    if (!d) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (d.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    return d
  }
  list(accountId: string): SavedDevice[] {
    return Object.values(this.state.accounts[accountId]?.devices ?? {}).filter(d => !d.revoked)
  }
  register(accountId: string, descriptor: AccountDeviceDescriptor): ReturnType<Store['issue']> {
    const devices = this.devices(accountId)
    const old = devices[descriptor.deviceId]
    if (old?.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    if (old && (old.descriptor.identityKey !== descriptor.identityKey || old.descriptor.role !== descriptor.role)) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    if (!old && Object.keys(devices).length >= 256) throw new ApiError('RATE_LIMITED', 429)
    devices[descriptor.deviceId] = { descriptor, revoked: false, lastSeenAt: old?.lastSeenAt ?? 0 }
    this.invalidate(accountId, descriptor.deviceId)
    return this.issue(accountId, descriptor.deviceId)
  }
  private issue(accountId: string, deviceId: string, refreshTokenExpiresAt = Date.now() + 30 * 86400_000, previous?: { token: string; record: SavedToken }) {
    const tokens = { ...this.state.tokens }
    for (const [key, value] of Object.entries(tokens)) if (value.expires <= Date.now()) delete tokens[key]
    if (Object.keys(tokens).length + 2 > 16384) throw new ApiError('RATE_LIMITED', 429)
    const accessTokenExpiresAt = Date.now() + 60 * 60_000
    const nonce = secret()
    const { accessToken, refreshToken } = previous
      ? successor(previous.token, nonce, deviceId)
      : { accessToken: secret(), refreshToken: secret() }
    if (previous) tokens[hash(previous.token)] = {
      ...previous.record, used: true, recovery: { nonce, accessExpires: accessTokenExpiresAt },
    }
    tokens[hash(accessToken)] = { kind: 'access', accountId, deviceId, expires: accessTokenExpiresAt, used: false }
    tokens[hash(refreshToken)] = { kind: 'refresh', accountId, deviceId, expires: refreshTokenExpiresAt, used: false }
    const before = this.state.tokens
    this.state.tokens = tokens
    // Commit consumption, recovery metadata and the successor together. A failed
    // write must leave the previous token usable both in memory and after restart.
    try { this.save() } catch (error) { this.state.tokens = before; throw error }
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
  }
  authenticate(token: string): AuthenticatedDevice {
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'access') throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    return { ...this.get(record.accountId, record.deviceId), accountId: record.accountId }
  }
  refresh(deviceId: string, token: string) {
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'refresh' || record.deviceId !== deviceId) throw new ApiError('AUTH_INVALID', 401)
    this.get(record.accountId, deviceId)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    if (!record.used) return this.issue(record.accountId, deviceId, record.expires, { token, record })
    // Legacy consumed tokens have no recovery record. Reject them without
    // invalidating credentials that may already be in use by this device.
    if (!record.recovery) throw new ApiError('AUTH_INVALID', 401)
    const pair = successor(token, record.recovery.nonce, deviceId)
    const next = this.state.tokens[hash(pair.refreshToken)]
    if (!next || next.kind !== 'refresh' || next.deviceId !== deviceId || next.expires !== record.expires) {
      throw new ApiError('INTERNAL_ERROR', 503)
    }
    if (next.used) throw new ApiError('AUTH_INVALID', 401)
    const access = this.state.tokens[hash(pair.accessToken)]
    if (access ? access.kind !== 'access' || access.deviceId !== deviceId || access.expires !== record.recovery.accessExpires
      : record.recovery.accessExpires > Date.now()) throw new ApiError('INTERNAL_ERROR', 503)
    // Return the original expiry, including an expired access bearer. The
    // recovered, still-valid refresh token can then rotate normally.
    return { ...pair, accessTokenExpiresAt: record.recovery.accessExpires, refreshTokenExpiresAt: next.expires }
  }
  invalidate(accountId: string, deviceId: string): void {
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.accountId === accountId && value.deviceId === deviceId) delete this.state.tokens[key]
    this.onInvalidate(accountId, deviceId)
    this.save()
  }
  revoke(accountId: string, id: string): void { this.get(accountId, id).revoked = true; this.invalidate(accountId, id) }
  rename(accountId: string, id: string, name: string): void {
    this.get(accountId, id).descriptor.name = name
    this.save()
  }
  touch(accountId: string, id: string, clientVersion?: string, harnessVersion?: string): void {
    const d = this.get(accountId, id)
    d.lastSeenAt = Date.now()
    if (clientVersion) d.descriptor.clientVersion = clientVersion.slice(0, 64)
    if (d.descriptor.role === 'host' && harnessVersion) d.descriptor.harnessVersion = harnessVersion.slice(0, 64)
    this.save()
  }
}