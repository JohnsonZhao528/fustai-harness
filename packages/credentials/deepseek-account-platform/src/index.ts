/** Platform PKCE account provider; browser approval never bypasses local cancellation. */
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { arch, platform, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promises as streamPromises } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { DeepSeekAccount, installAccountTaskCancellation, mergePlatformCookies, platformClientHeaders, platformWireLocale, type AccountBonusBatch, type AccountBonusOrderId, type AccountClientMetadata, type AccountDetails, type AccountUserId, type AccountView, type PlatformSession, type SignInAttemptId, type SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import { credentialKey, credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { ACCOUNT_UID_PATTERN, accountDataRoot, DSH_ACCOUNTS_DIR_NAME, dshBaseHome, ownsHarnessHome, readAccountPointer, resolveDshHome, writeAccountPointer, type AccountPointer } from '@deepseek-ai/dsh-home-paths'
import { CREDENTIALS_FILENAME, storeCredentialRecord } from '@deepseek-ai/dsh-credentials-local'
import { profile, readAccountDetail, readUnnotifiedBonuses, sendBonusNotified } from './details.ts'
import { revokeAccount, type LogoutRetryPolicy } from './logout.ts'
import { AccountUnauthorizedError, AccountNotFoundError, PlatformAuthError, platformHeaders, platformOrigin, browserUrl, requestPlatform, initialization, exchange, loginOrigin, modelKey, requestModelKey, requestSharedCredentials, uploadSharedCredentials } from './protocol.ts'

const KEY = credentialKey('deepseek-account-platform', 'default')
const DEVICE = credentialKey('deepseek-account-platform', 'device')
/**
 * Stored platform session. Version 2 records the account id the Platform
 * returned, which is the id the grant is filed under in the account's own data
 * root. Version 1 stays readable: a session signed in before per-account roots
 * exists, and so does one from a Platform response carrying no usable id.
 */
const grant = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), token: z.string().min(1), issuer: z.url() }),
  z.object({ version: z.literal(2), token: z.string().min(1), issuer: z.url(), uid: z.string().regex(ACCOUNT_UID_PATTERN) }),
])
const device = z.object({ id: z.uuid() })

/** Deployment-specific platform and request deadlines. */
export interface Config {
  /** Platform origin serving auth-api and browser pages. */
  platformOrigin?: string
  /** Native desktop identity for Host API and embedded Platform requests; null identifies the client as web. */
  desktopPlatform?: 'darwin' | 'win32' | null
  /** Optional frontend deployment selector for embedded Usage and Top-up pages. */
  embeddedPageDist?: string
  /** Exact HTTP(S) origin allowed to receive account tokens for inference and files. */
  inferenceOrigin?: string
  /** Credential reference the Platform-issued inference key is stored under. */
  modelKeyRef?: string
  /** Endpoint stored with the shared key; empty reuses inferenceOrigin. */
  sharedBaseUrl?: string
  /** Allow HTTP only on loopback for the development Mock. */
  allowLoopbackHttp?: boolean
  /** Map authorization and completion pages to platformOrigin for private development proxies. */
  rewriteBrowserOrigin?: boolean
  /** Host-only headers sent exclusively to platformOrigin; account authorization cannot be overridden. */
  requestHeaders?: Record<string, string>
  /** Overrides for profile, balance and embedded Platform requests; Cookie pairs merge by name. Logout retains requestHeaders. */
  accountRequestHeaders?: Record<string, string>
  /** Deadline for each platform HTTP request. */
  requestTimeoutMs?: number
  /** Deadline for recharge-wallet queries; timeout returns a failed balance outcome. */
  balanceTimeoutMs?: number
  /** Additional logout attempts after the first request fails, at most five. */
  logoutMaxRetries?: number
  /** Delay before the first logout retry; each later delay doubles. */
  logoutRetryDelayMs?: number
  /** Upper bound for the entire local attempt, even if the server advertises a longer TTL. */
  attemptTimeoutMs?: number
}
/** Validated deployment choices. */
export const Config = Schema.object({
  platformOrigin: Schema.string().default('https://platform.deepseek.com'),
  desktopPlatform: Schema.union([Schema.const('darwin'), Schema.const('win32'), Schema.const(null)]).default(null),
  embeddedPageDist: Schema.string().default(''),
  inferenceOrigin: Schema.string().default('https://api.deepseek.com'),
  modelKeyRef: Schema.string().default('DEEPSEEK_API_KEY'),
  sharedBaseUrl: Schema.string().default(''),
  allowLoopbackHttp: Schema.boolean().default(false),
  rewriteBrowserOrigin: Schema.boolean().default(false),
  requestHeaders: Schema.dict(Schema.string().role('secret')).default({}),
  accountRequestHeaders: Schema.dict(Schema.string().role('secret')).default({}),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  balanceTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  logoutMaxRetries: Schema.number().min(0).max(5).step(1).default(5),
  logoutRetryDelayMs: Schema.number().min(1).max(60_000).default(1_000),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
})

interface Attempt {
  locale: 'en_US' | 'zh_CN'
  clientHeaders: Record<string, string>
  view: SignInAttemptView
  controller: AbortController
  done: Promise<void>
  running: Promise<void>
  origin: string
  loginSource: 'web' | 'desktop'
  disposeCallback?: () => Promise<void>
  callback?: ServerResponse
  initialProfile?: { token: string; value: AccountDetails['profile'] }
  completionUrl?: string
  /** Grant filed in another document; its local copy goes once begin() has confirmed the commit. */
  grantHandoff?: boolean
}

/** The platform implementation owns login state and its opaque stored grant. */
export class PlatformAccount extends DeepSeekAccount {
  static inject = ['credentials', 'authorization']
  static Config = Config
  private readonly origin: string
  private readonly embeddedPageDist: string
  private readonly inferenceOrigin: string
  private readonly sharedBaseUrl: string
  private readonly modelKeyRef: CredentialRef
  private readonly rewriteBrowserOrigin: boolean
  private readonly platform: 'darwin' | 'win32' | null
  private readonly requestHeaders: Record<string, string>
  private readonly accountRequestHeaders: Record<string, string>
  private readonly requestTimeout: number
  private readonly balanceTimeout: number
  private readonly attemptTimeout: number
  private readonly logoutPolicy: LogoutRetryPolicy
  private readonly logoutLifetime = new AbortController()
  private readonly revocations = new Set<Promise<void>>()
  private attempt: Attempt | undefined
  private readonly listeners = new Set<(identityOnly: boolean) => void>()
  /**
   * Latest ready profile read and the grant token it was read with. Binding the token keeps a
   * cached identity from answering for a credential that has since changed.
   */
  private lastProfile: { readonly token: string; readonly profile: Extract<AccountDetails['profile'], { status: 'ready' }> } | undefined
  private detailsLifetime = new AbortController()
  private closed = false
  private removing: Promise<AccountView> | undefined
  /** Startup re-issue of a missing inference key; awaited before the plugin releases its context. */
  private modelKeyDelivery: Promise<void> | undefined
  /** Credential the account center currently resolves to; a local key equal to it is never uploaded back. */
  private sharedModelKey: string | undefined
  /** In-flight shared-credential reads and uploads, awaited on dispose. */
  private readonly keyShares = new Set<Promise<void>>()
  /**
   * Data root this process stores to, captured before any sign-in can rewrite the account pointer.
   * Session, settings, and credential providers resolve the same root at startup, so the pointer
   * takes effect for them only after a restart while this process keeps serving this directory.
   */
  private readonly dataRoot = resolveDshHome()

  /** @param ctx - Host with authorization and credentials services. @param config - deployment options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    installAccountTaskCancellation(ctx)
    const resolved = Config(config)
    this.embeddedPageDist = resolved.embeddedPageDist
    this.origin = platformOrigin(resolved.platformOrigin, resolved.allowLoopbackHttp)
    const inference = new URL(resolved.inferenceOrigin)
    if (!['http:', 'https:'].includes(inference.protocol) || inference.username || inference.password
      || inference.pathname !== '/' || inference.search || inference.hash) {
      throw new Error('account: inferenceOrigin must be an HTTP(S) origin without credentials, path, query or fragment')
    }
    this.inferenceOrigin = inference.origin
    const shared = resolved.sharedBaseUrl.trim()
    const sharedUrl = shared === '' ? undefined : new URL(shared)
    if (sharedUrl !== undefined && (!['http:', 'https:'].includes(sharedUrl.protocol)
      || sharedUrl.username || sharedUrl.password || sharedUrl.search || sharedUrl.hash)) {
      throw new Error('account: sharedBaseUrl must be an HTTP(S) URL without credentials, query or fragment')
    }
    this.sharedBaseUrl = sharedUrl === undefined
      ? this.inferenceOrigin
      : `${sharedUrl.origin}${sharedUrl.pathname.replace(/\/+$/, '')}`
    this.modelKeyRef = credentialRef(resolved.modelKeyRef)
    this.rewriteBrowserOrigin = resolved.rewriteBrowserOrigin
    this.platform = resolved.desktopPlatform
    this.requestHeaders = platformHeaders(resolved.requestHeaders)
    const accountHeaders = platformHeaders(resolved.accountRequestHeaders)
    this.accountRequestHeaders = { ...this.requestHeaders, ...accountHeaders }
    if (accountHeaders.cookie !== undefined) {
      this.accountRequestHeaders.cookie = mergePlatformCookies(this.requestHeaders.cookie ?? '', accountHeaders.cookie)
    }
    this.requestTimeout = resolved.requestTimeoutMs
    this.balanceTimeout = resolved.balanceTimeoutMs
    this.attemptTimeout = resolved.attemptTimeoutMs
    this.logoutPolicy = {
      maxRetries: resolved.logoutMaxRetries, delayMs: resolved.logoutRetryDelayMs, requestTimeoutMs: this.requestTimeout,
    }
    ctx.authorization.registerFlow({
      key: KEY, label: 'DeepSeek', methods: [{ id: 'browser', label: 'DeepSeek' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined) return Promise.reject(new PlatformAuthError('protocol'))
        attempt.running = this.run(session, attempt)
        return attempt.running
      },
    })
    ctx.on('credentials/record-updated', (key) => {
      if (key !== KEY) return
      this.invalidateDetails()
      this.changed()
    })
    ctx.on('credentials/reference-updated', (ref) => {
      if (ref !== this.modelKeyRef) return
      // A locally entered model key is shared with the account, so the phone and the
      // next desktop sign-in load the same credential. The newest entry wins.
      this.uploadLocalModelKey()
    })
    ctx.effect(() => async () => {
      this.closed = true
      this.logoutLifetime.abort()
      this.invalidateDetails()
      const active = this.attempt
      if (active !== undefined) {
        if (active.view.phase !== 'committing') active.controller.abort()
        await active.done
      }
      await this.removing
      await this.modelKeyDelivery
      await Promise.all(this.keyShares)
      await Promise.all(this.revocations)
      this.changed()
    }, 'account: active attempt lifetime')
  }

  async [Service.init](): Promise<void> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = grant.safeParse(record.payload)
    if (!parsed.success) throw new PlatformAuthError('storage')
    if (parsed.data.issuer !== this.origin) {
      await this.ctx.credentials.deleteRecord(KEY)
      return
    }
    if (parsed.data.version === 2 && parsed.data.uid !== accountOfRoot()) {
      // A copy made for another account's root before the pointer landed; this root
      // must never act as that account.
      await this.ctx.credentials.deleteRecord(KEY)
      return
    }
    // An interrupted sign-in can leave a grant without its key; the grant re-issues one off the critical path.
    if (await this.ctx.credentials.resolve(this.modelKeyRef) === undefined) {
      this.modelKeyDelivery ??= this.deliverModelKeyOrReport(parsed.data.token, {})
    } else {
      // A key configured on this desktop seeds an account that has none yet; an account that
      // already resolves to one becomes this device's key instead.
      this.alignSharedModelKey(parsed.data.token)
    }
  }

  override async getState(): Promise<AccountView> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record !== undefined && (record.kind !== 'grant' || !grant.safeParse(record.payload).success)) {
      throw new PlatformAuthError('storage')
    }
    const attempt = this.attempt?.view ?? null
    const view: AccountView = {
      status: record === undefined ? 'signed-out' : 'credential-stored',
      // Credential removal can notify watchers before sign-out finishes clearing the attempt.
      attempt: record === undefined && attempt?.phase === 'succeeded' ? null : attempt,
      links: { usageUrl: new URL('/usage', this.origin).href, topUpUrl: new URL('/top_up', this.origin).href },
    }
    // The pointer now names another directory than the one this process stores to, so this account's
    // sessions, settings, and credentials reach that directory only after a restart.
    return resolveDshHome() === this.dataRoot ? view : { ...view, restartRequired: true }
  }

  override async getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    const result = await this.getDetail('profile', this.detailHeaders(client), { lifetime, stored })
    if (this.detailsLifetime !== lifetime) return null
    if (result !== null) this.cacheProfile(stored.token, result)
    if (result?.status !== 'failed') return result
    // Only this same grant's last ready read may stand in for a failed refresh.
    const cached = this.lastProfile?.token === stored.token ? this.lastProfile.profile : undefined
    return cached ?? result
  }

  override getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    return this.getDetail('balance', this.detailHeaders(client))
  }

  override async getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null> {
    const lifetime = this.detailsLifetime
    const headers = this.detailHeaders(client)
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null) return null
    const accountId = await this.currentAccountId(lifetime, stored, headers)
    if (accountId === null) return null
    try {
      const bonuses = await readUnnotifiedBonuses(this.origin, stored.token,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.requestTimeout)]), headers)
      return { accountId, bonuses }
    } catch (error) {
      if (error instanceof AccountUnauthorizedError) {
        if (this.detailsLifetime === lifetime) await this.expireCredential(stored.token, lifetime)
        return null
      }
      throw error
    }
  }

  override async ackBonusNotified(accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata): Promise<boolean> {
    const lifetime = this.detailsLifetime
    const headers = this.detailHeaders(client)
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null) return false
    const current = await this.currentAccountId(lifetime, stored, headers)
    if (current === null || current !== accountId) return false
    try {
      await sendBonusNotified(this.origin, stored.token, orderId,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.requestTimeout)]), headers)
      return true
    } catch (error) {
      if (error instanceof AccountUnauthorizedError) {
        if (this.detailsLifetime === lifetime) await this.expireCredential(stored.token, lifetime)
        return false
      }
      throw error
    }
  }

  /**
   * Resolve the profile identity bound to one captured grant, within that grant's credential lifetime.
   * @param lifetime - credential lifetime the grant was captured under; a change discards the result.
   * @param stored - captured grant; the identity query never re-reads a newer credential.
   * @param headers - client identity headers of the calling operation.
   * @returns the account identity, or null while signed out or after the credential changed.
   */
  private async currentAccountId(lifetime: AbortController, stored: z.infer<typeof grant>,
    headers: Record<string, string>): Promise<AccountUserId | null> {
    // A profile already read for this same captured grant names the account, so a bonus read or
    // acknowledgement reuses it instead of issuing another current query.
    if (this.lastProfile?.token === stored.token) return this.identityOf(this.lastProfile.profile)
    const details = await this.getDetail('profile', headers, { lifetime, stored })
    if (details === null) return null
    if (details.status === 'failed') {
      // The query named no identity, and the cache is empty or belongs to another grant.
      throw new PlatformAuthError('network')
    }
    this.cacheProfile(stored.token, details)
    return this.identityOf(details)
  }

  /**
   * Cache one ready profile against the grant token it was read with, so identity reuse cannot cross
   * a credential change. A stable ID that first appears or changes notifies identity-enabled watch consumers, so
   * identity consumers re-read getPlatformSession; repeated IDs stay silent.
   * @param token - grant the profile was read with.
   * @param profile - profile outcome to record when it carries account data.
   */
  private cacheProfile(token: string, profile: AccountDetails['profile']): void {
    if (profile.status !== 'ready') return
    // Identity publishers re-read the session snapshot; wake them only when the stable ID changes.
    const previous = this.lastProfile?.profile.value.id || null
    this.lastProfile = { token, profile }
    if (previous !== (profile.value.id || null)) this.changed(true)
  }

  /**
   * @param profile - ready profile projected for the UI.
   * @returns the account identity it names.
   * @throws PlatformAuthError when the profile carries no stable Platform id, which cannot isolate notices.
   */
  private identityOf(profile: Extract<AccountDetails['profile'], { status: 'ready' }>): AccountUserId {
    if (profile.value.id === null) throw new PlatformAuthError('protocol')
    return profile.value.id
  }

  private async getDetail<K extends keyof AccountDetails>(field: K, headers: Record<string, string>,
    captured?: { lifetime: AbortController; stored: z.infer<typeof grant> }): Promise<AccountDetails[K] | null> {
    const lifetime = captured?.lifetime ?? this.detailsLifetime
    const stored = captured?.stored ?? await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    if (field === 'profile' && this.attempt?.initialProfile?.token === stored.token) {
      const initial = this.attempt.initialProfile.value
      delete this.attempt.initialProfile
      return initial as AccountDetails[K]
    }
    try {
      const details = await readAccountDetail(field, this.origin, stored.token,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(field === 'balance' ? this.balanceTimeout : this.requestTimeout)]), headers)
      return this.detailsLifetime !== lifetime ? null : details
    } catch (_unauthorized) {
      // readAccountDetail exposes only authenticated credential rejection failures.
      if (this.detailsLifetime === lifetime) await this.expireCredential(stored.token, lifetime)
      return null
    }
  }

  /** Deployment account headers plus the client identity headers derived from one call's metadata. */
  private detailHeaders(client: AccountClientMetadata): Record<string, string> {
    return { ...this.accountRequestHeaders, ...platformClientHeaders(this.platform, client) }
  }

  override async rejectToken(token: string): Promise<void> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored?.token !== token || this.detailsLifetime !== lifetime) return
    await this.expireCredential(token, lifetime)
  }

  private async expireCredential(token: string, lifetime: AbortController): Promise<void> {
    this.removing ??= (async () => {
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      const record = await this.ctx.credentials.readRecord(KEY)
      if (this.closed || this.detailsLifetime !== lifetime || record?.kind !== 'grant') return this.getState()
      const current = grant.parse(record.payload)
      if (current.token !== token || current.issuer !== this.origin) return this.getState()
      await this.ctx.credentials.deleteRecord(KEY)
      await this.ctx.credentials.unset(this.modelKeyRef)
      this.clearActiveAccount()
      this.ctx.emit('deepseek-account/session-expired')
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed()
      return this.getState()
    })().finally(() => { this.removing = undefined })
    await this.removing
  }

  override async getDeviceIdentity(): Promise<{ deviceId?: string; userId?: AccountUserId; osVersion: string }> {
    const [record, session] = await Promise.all([
      this.ctx.credentials.readRecord(DEVICE),
      this.getPlatformSession(),
    ])
    const parsed = record?.kind === 'grant' ? device.safeParse(record.payload) : undefined
    return {
      ...parsed?.success ? { deviceId: parsed.data.id } : {},
      ...session?.userId == null ? {} : { userId: session.userId },
      osVersion: deviceOsVersion(),
    }
  }

  override async getPlatformSession(): Promise<PlatformSession | null> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    // Deployment headers only; the consuming client adds the identity of its own UI.
    const requestHeaders = { ...this.accountRequestHeaders }
    // Identity comes from the profile read for this same grant; an unknown ID requires disposable
    // browser storage. A replaced credential never publishes the account its predecessor named.
    return { origin: this.origin, token: stored.token,
      userId: this.lastProfile?.token === stored.token ? this.lastProfile.profile.value.id || null : null,
      ...(this.embeddedPageDist ? { embeddedPageDist: this.embeddedPageDist } : {}),
      requestHeaders }
  }

  private async readCurrentGrant(lifetime: AbortController): Promise<z.infer<typeof grant> | null> {
    if (this.closed) return null
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined || lifetime.signal.aborted) return null
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = grant.safeParse(record.payload)
    if (!parsed.success) throw new PlatformAuthError('storage')
    // A private origin override must never forward a grant issued by another environment.
    if (parsed.data.issuer !== this.origin) throw new PlatformAuthError('protocol')
    return parsed.data
  }

  override async resolveToken(url: string): Promise<string | undefined> {
    if (this.closed || this.removing !== undefined) return undefined
    const destination = new URL(url)
    if (destination.origin !== this.inferenceOrigin || destination.username || destination.password) return undefined
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return undefined
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const result = grant.safeParse(record.payload)
    if (!result.success) throw new PlatformAuthError('storage')
    // Development grants cannot authenticate production model or file requests.
    const issuer = new URL(result.data.issuer)
    if (result.data.token.startsWith('dsh_mock_')) return undefined
    if (this.inferenceOrigin === 'https://api.deepseek.com') {
      if (['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)) return undefined
    } else if (issuer.origin !== this.origin) return undefined
    return result.data.token
  }

  override async startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView> {
    if (this.removing !== undefined) await this.removing
    const origin = loginOrigin(callbackOrigin)
    if (this.closed) throw new PlatformAuthError('protocol')
    if (this.attempt !== undefined && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(this.attempt.view.phase)) {
      return this.getState()
    }
    const previous = this.attempt
    if (previous !== undefined) {
      await previous.done
      // Disposal can close the provider while the previous attempt settles.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.closed) throw new PlatformAuthError('protocol')
      if (this.attempt !== previous) return this.getState()
    }
    const attempt: Attempt = {
      origin, loginSource,
      locale: platformWireLocale(client.locale),
      clientHeaders: platformClientHeaders(this.platform, client),
      view: { id: randomUUID() as SignInAttemptId, phase: 'initializing' },
      controller: new AbortController(), done: Promise.resolve(), running: Promise.resolve(),
    }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: KEY, signal: attempt.controller.signal,
      interaction: { notify: () => undefined, prompt: () => Promise.reject(new PlatformAuthError('protocol')) },
    }).then(async (outcome) => {
      this.update(attempt, { phase: outcome.status === 'authorized' ? 'succeeded' : 'cancelled' })
      if (outcome.status === 'authorized' && attempt.completionUrl !== undefined) {
        attempt.callback?.writeHead(302, { location: attempt.completionUrl, 'cache-control': 'no-store' }).end()
      } else attempt.callback?.writeHead(204, { 'cache-control': 'no-store' }).end()
      if (outcome.status === 'authorized' && attempt.grantHandoff === true) {
        // begin() has re-read the committed grant from the account document; the
        // local copy may go now. A failed removal self-heals on the next boot,
        // whose startup reconciliation drops records filed under another root.
        try { await this.ctx.credentials.deleteRecord(KEY) }
        catch (error) { console.error('[deepseek-account] local grant removal after root handoff failed', error) }
      }
    }).catch((error: unknown) => {
      const code = error instanceof PlatformAuthError ? error.code : 'protocol'
      console.error('[deepseek-account] sign-in failed', { errorCode: code })
      this.update(attempt, { phase: code === 'expired' ? 'expired' : 'failed', errorCode: code })
      this.finishFailedCallback(attempt)
    }).then(async () => {
      // begin() may report cancellation before the HTTP work observes its signal.
      await attempt.running.catch(() => undefined)
      if (attempt.callback !== undefined) {
        await streamPromises.finished(attempt.callback, { cleanup: true }).catch(() => undefined)
      }
      await attempt.disposeCallback?.()
    })
    this.changed()
    return this.getState()
  }

  override async cancelSignIn(id: SignInAttemptId): Promise<AccountView> {
    const attempt = this.attempt
    if (attempt?.view.id === id) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.ctx.authorization.cancel(KEY)
      }
      await attempt.done
    }
    return this.getState()
  }

  override signOut(client: AccountClientMetadata): Promise<AccountView> {
    this.removing ??= (async () => {
      if (this.closed) throw new PlatformAuthError('protocol')
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      const record = await this.ctx.credentials.readRecord(KEY)
      if (record !== undefined) {
        if (record.kind !== 'grant') throw new PlatformAuthError('storage')
        const parsed = grant.safeParse(record.payload)
        if (!parsed.success) throw new PlatformAuthError('storage')
        if (parsed.data.issuer !== this.origin) throw new PlatformAuthError('protocol')
        await this.ctx.credentials.deleteRecord(KEY)
        await this.ctx.credentials.unset(this.modelKeyRef)
        this.clearActiveAccount()
        this.revoke(parsed.data.token, platformClientHeaders(this.platform, client))
      }
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed()
      return this.getState()
    })().finally(() => { this.removing = undefined })
    return this.removing
  }

  override async *watch(signal: AbortSignal, includeIdentityChanges = false): AsyncIterable<AccountView> {
    let dirty = true
    let wake: (() => void) | undefined
    const wakeUp = (): void => { dirty = true; wake?.() }
    const changed = (identityOnly: boolean): void => { if (!identityOnly || includeIdentityChanges) wakeUp() }
    this.listeners.add(changed)
    signal.addEventListener('abort', wakeUp, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', wakeUp)
    }
  }

  private revoke(token: string, headers: Record<string, string>): void {
    if (this.closed) return
    const revocation = revokeAccount(this.origin, token, this.logoutPolicy,
      this.logoutLifetime.signal, { ...this.requestHeaders, ...headers }).finally(() => { this.revocations.delete(revocation) })
    this.revocations.add(revocation)
  }

  private invalidateDetails(): void {
    this.lastProfile = undefined
    this.detailsLifetime.abort()
    this.detailsLifetime = new AbortController()
  }

  private changed(identityOnly = false): void { for (const listener of this.listeners) listener(identityOnly) }

  private update(attempt: Attempt, value: Partial<SignInAttemptView>): void {
    const { authorizeUrl: _url, ...rest } = attempt.view
    attempt.view = { ...rest, ...value }
    this.changed()
  }

  private async run(session: AuthorizationSession, attempt: Attempt): Promise<void> {
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new PlatformAuthError('protocol')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    let authorizeId: string | undefined
    const code = Promise.withResolvers<string>()
    // Callback requests may precede initialization settlement; the rejection is observed immediately.
    void code.promise.catch(() => undefined)
    const deadline = new AbortController()
    let expiresAt = Date.now() + this.attemptTimeout
    const signal = AbortSignal.any([session.signal, deadline.signal])
    let timer = setTimeout(() =>{  deadline.abort() }, this.attemptTimeout)
    const abort = (): void => { code.reject(new PlatformAuthError('expired')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      attempt.disposeCallback = this.ctx.effect(() => webServer.register({
        kind: 'exact', path: '/oauth/callback', handler: (req, res) => {
          let url: URL
          try { url = new URL(req.url ?? '/', 'http://127.0.0.1') }
          catch { res.writeHead(400, { 'cache-control': 'no-store' }).end(); return }
          const receivedCode = url.searchParams.get('code')
          const receivedState = url.searchParams.get('state') ?? ''
          const validState = Buffer.byteLength(receivedState) === Buffer.byteLength(state)
            && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
          if (req.method !== 'GET' || url.pathname !== '/oauth/callback' || !validState || !receivedCode
            || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) {
            res.writeHead(400, { 'cache-control': 'no-store' }).end(); return
          }
          if (signal.aborted || attempt.callback !== undefined || attempt.view.phase !== 'waiting-browser') {
            res.writeHead(410, { 'cache-control': 'no-store' }).end(); return
          }
          attempt.callback = res
          code.resolve(receivedCode)
        },
      }), 'account: browser callback')
      signal.throwIfAborted()
      const redirectUri = `${attempt.origin}/oauth/callback`
      const init = initialization.safeParse(await this.request('auth_init', {
        code_challenge: challenge, code_challenge_method: 'S256', state, redirect_uri: redirectUri, locale: attempt.locale,
        login_source: attempt.loginSource,
      }, signal, attempt.clientHeaders), { reportInput: true })
      if (!init.success) this.rejectPayload('auth_init', init.error)
      const authorizeUrl = browserUrl(init.data.authorize_url, this.origin, '/dsh/authorize', this.rewriteBrowserOrigin)
      authorizeId = init.data.authorize_id
      signal.throwIfAborted()
      const now = Date.now()
      expiresAt = Math.min(expiresAt, now + init.data.expires_in * 1000)
      const remaining = expiresAt - now
      if (remaining <= 0) { deadline.abort(); signal.throwIfAborted() }
      clearTimeout(timer)
      timer = setTimeout(() =>{  deadline.abort() }, remaining)
      this.update(attempt, { phase: 'waiting-browser', authorizeUrl, expiresAt })
      const receivedCode = await code.promise
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      const deviceRecord = await this.ctx.credentials.modifyRecord(DEVICE, current => Promise.resolve(current === undefined
        ? { kind: 'grant', payload: { id: randomUUID() } } : undefined))
      if (deviceRecord?.kind !== 'grant') throw new PlatformAuthError('storage')
      const identity = device.parse(deviceRecord.payload)
      const result = exchange.safeParse(await this.request('auth_exchange', {
        code: receivedCode, code_verifier: verifier, redirect_uri: redirectUri,
        device_id: identity.id, device_model: `${platform()}-${arch()}`, os_version: deviceOsVersion(),
      }, signal, attempt.clientHeaders), { reportInput: true })
      if (!result.success) this.rejectPayload('auth_exchange', result.error)
      const completionUrl = new URL(browserUrl(result.data.authorized_url, this.origin, '/dsh/authorized', this.rewriteBrowserOrigin))
      completionUrl.searchParams.set('login_source', attempt.loginSource)
      attempt.completionUrl = completionUrl.href
      if (Date.now() >= expiresAt) deadline.abort()
      signal.throwIfAborted()
      if (result.data.user != null) {
        try { attempt.initialProfile = { token: result.data.token, value: { status: 'ready', value: profile(result.data.user) } } }
        catch {
          // Invalid optional user data falls back to current without discarding a valid authorization.
        }
      }
      this.update(attempt, { phase: 'committing' })
      clearTimeout(timer)
      const token = result.data.token
      const uid = accountUidOf(attempt)
      try {
        await session.commit({ kind: 'grant', payload: uid === undefined
          ? { version: 1, token, issuer: this.origin }
          : { version: 2, token, issuer: this.origin, uid } })
      } catch { throw new PlatformAuthError('storage') }
      if (uid === undefined) await this.deliverModelKeyOrReport(token, attempt.clientHeaders)
      else if (await this.activateAccountRoot(uid, token, attempt.clientHeaders)) attempt.grantHandoff = true
    } catch (error) {
      if (deadline.signal.aborted) throw new PlatformAuthError('expired')
      throw error
    } finally {
      if (signal.aborted && authorizeId !== undefined) this.cancelRequest(authorizeId, verifier, attempt.clientHeaders)
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      // begin() settles the browser response and removes only this attempt’s route.
    }
  }

  /**
   * Store the inference credential the Platform provisions for the signed-in account, reporting any
   * failure without reversing the grant that was already committed.
   * @param token - account grant used to request the key.
   * @param headers - client identity headers for this origin.
   */
  private async deliverModelKeyOrReport(token: string, headers: Record<string, string>): Promise<void> {
    if (this.closed) return
    try {
      const response = modelKey.safeParse(await requestModelKey(this.origin, token,
        AbortSignal.timeout(this.requestTimeout), { ...this.requestHeaders, ...headers }))
      if (!response.success) throw new PlatformAuthError('protocol')
      if (new URL(response.data.base_url).origin !== this.inferenceOrigin) {
        console.error('[deepseek-account] model key issued for another inference origin', { base_url: response.data.base_url })
        return
      }
      // Mark before the write: the reference-updated listener must not upload this key back.
      this.sharedModelKey = response.data.api_key
      await this.ctx.credentials.set(this.modelKeyRef, response.data.api_key)
    } catch (error) {
      console.error('[deepseek-account] model key delivery failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      })
      // Delivery failing can mean the account has no key at all: align it with this device.
      this.alignSharedModelKey(token)
    }
  }

  /**
   * Align this device with the credential the account resolves to: an account that already has one
   * becomes the local key of every device, and exactly an account without one receives this
   * device's key.
   * @param token - account grant used for the shared-credential requests.
   */
  private alignSharedModelKey(token: string): void {
    if (this.closed) return
    const share = (async () => {
      try {
        const remote = modelKey.safeParse(await requestSharedCredentials(this.origin, token,
          AbortSignal.timeout(this.requestTimeout), this.requestHeaders))
        if (!remote.success) return
        if (new URL(remote.data.base_url).origin !== this.inferenceOrigin) {
          console.error('[deepseek-account] shared model key issued for another inference origin', { base_url: remote.data.base_url })
          return
        }
        // Mark before the write: the reference-updated listener must not upload this key back.
        this.sharedModelKey = remote.data.api_key
        if ((await this.ctx.credentials.resolve(this.modelKeyRef))?.value === remote.data.api_key) return
        await this.ctx.credentials.set(this.modelKeyRef, remote.data.api_key)
      } catch (error) {
        if (!(error instanceof AccountNotFoundError)) throw error
        const local = (await this.ctx.credentials.resolve(this.modelKeyRef))?.value
        if (local === undefined) return
        await uploadSharedCredentials(this.origin, token, local, this.sharedBaseUrl,
          AbortSignal.timeout(this.requestTimeout), this.requestHeaders)
        this.sharedModelKey = local
      }
    })().catch((error: unknown) => {
      console.error('[deepseek-account] model key sharing failed', { reason: error instanceof Error ? error.name : 'unknown' })
    })
    this.trackKeyShare(share)
  }

  /** Upload a locally entered key; the key that just arrived from the account is not sent back. */
  private uploadLocalModelKey(): void {
    if (this.closed) return
    const share = (async () => {
      const local = (await this.ctx.credentials.resolve(this.modelKeyRef))?.value
      if (local === undefined || local === this.sharedModelKey) return
      const stored = await this.readCurrentGrant(this.detailsLifetime)
      if (stored === null) return
      await uploadSharedCredentials(this.origin, stored.token, local, this.sharedBaseUrl,
        AbortSignal.timeout(this.requestTimeout), this.requestHeaders)
      this.sharedModelKey = local
    })().catch((error: unknown) => {
      console.error('[deepseek-account] model key upload failed', { reason: error instanceof Error ? error.name : 'unknown' })
    })
    this.trackKeyShare(share)
  }

  /** @param share - settled sharing operation to keep alive until dispose. */
  private trackKeyShare(share: Promise<void>): void {
    this.keyShares.add(share)
    void share.finally(() => { this.keyShares.delete(share) })
  }

  /**
   * File the just-committed grant under the signed-in account's data root and point
   * the harness home at it. The pointer is written after the copy, so a failed copy
   * leaves the session on the previous root. The model key follows the grant: on the
   * shared home it is delivered now, in a per-account root on that root's next boot
   * through the startup re-issue path.
   * @param uid - account id accepted by {@link ACCOUNT_UID_PATTERN}.
   * @param token - the grant token just committed.
   * @param headers - client identity headers for model-key delivery on the shared home.
   * @returns whether the grant lives in another document and the local copy still
   *   needs removal; removal must wait until authorization's commit confirmation has
   *   re-read the stored record, which happens after this call returns.
   */
  private async activateAccountRoot(uid: string, token: string, headers: Record<string, string>): Promise<boolean> {
    const base = dshBaseHome()
    // Compare against where this process actually stores, never against the pointer: before a
    // restart the pointer already names the new account while this document is still the old one.
    const runtime = this.dataRoot
    const pointer = readAccountPointer(base)
    const next: AccountPointer = { activeUid: uid, firstOwnerUid: pointer?.firstOwnerUid ?? uid }
    const target = ownsHarnessHome(next, uid) ? base : accountDataRoot(base, uid)
    if (target !== runtime) {
      await storeCredentialRecord(join(target, CREDENTIALS_FILENAME), KEY, {
        kind: 'grant', payload: { version: 2, token, issuer: this.origin, uid },
      })
    }
    await writeAccountPointer(base, next)
    if (target === runtime) {
      await this.deliverModelKeyOrReport(token, headers)
      return false
    }
    return true
  }

  /**
   * Drop the active account so the next boot resolves the shared home again. The
   * first owner's claim is kept: its data stays where it is, and a later sign-in
   * must not hand that data to a different account.
   */
  private clearActiveAccount(): void {
    const base = dshBaseHome()
    const pointer = readAccountPointer(base)
    if (pointer === undefined || pointer.activeUid === null) return
    writeAccountPointer(base, { ...pointer, activeUid: null })
  }

  private rejectPayload(stage: string, error: z.ZodError): never {
    console.error('[deepseek-account] payload rejected', {
      stage, issues: error.issues.map(issue => ({
        path: issue.path, code: issue.code,
        receivedType: issue.input === null ? 'null' : Array.isArray(issue.input) ? 'array' : typeof issue.input,
      })),
    })
    throw new PlatformAuthError('protocol')
  }

  private cancelRequest(authorizeId: string, verifier: string, headers: Record<string, string>): void {
    if (this.closed) return
    const cancellation = this.request('auth_cancel', { authorize_id: authorizeId, code_verifier: verifier },
      this.logoutLifetime.signal, headers).then(() => undefined, () => {
      // Remote cancellation failures never reverse local cancellation or expose verifier diagnostics.
    }).finally(() => { this.revocations.delete(cancellation) })
    this.revocations.add(cancellation)
  }

  private request(method: string, body: unknown, signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
    return requestPlatform(this.origin, method, body,
      AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeout)]), { ...this.requestHeaders, ...headers })
  }

  private finishFailedCallback(attempt: Attempt): void {
    if (attempt.loginSource === 'web') {
      const nonce = randomBytes(16).toString('base64url')
      const message = attempt.locale === 'zh_CN' ? '登录失败，请关闭此标签页并在原页面重试。'
        : 'Sign-in failed. Close this tab and try again in the original tab.'
      attempt.callback?.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
      }).end(`<!doctype html><html lang="${attempt.locale === 'zh_CN' ? 'zh-CN' : 'en'}"><meta charset="utf-8"><title>${message}</title>`
        + `<body><p>${message}</p><script nonce="${nonce}">window.close()</script></body></html>`)
    } else {
      // Native account subscribers focus the login window; retain the browser’s Platform document.
      attempt.callback?.writeHead(204, { 'cache-control': 'no-store' }).end()
    }
  }
}
export default PlatformAccount

/** OS identification shared by login and credential-free identity reads. */
function deviceOsVersion(): string {
  return `${platform()} ${release()}`
}

/**
 * The account id usable as a per-account data root, taken from the identity the
 * exchange response carried. An absent or unusable id keeps the version 1 grant,
 * which lives in the shared home like every session predating per-account roots.
 * @param attempt - the sign-in whose exchange populated the initial profile.
 * @returns the account id, or undefined when it cannot be trusted as a path segment.
 */
function accountUidOf(attempt: Attempt): string | undefined {
  const state = attempt.initialProfile?.value
  if (state === undefined || state.status !== 'ready') return undefined
  const id: string | null = state.value.id
  return id !== null && ACCOUNT_UID_PATTERN.test(id) ? id : undefined
}

/**
 * The account id owning the data root this process resolved. Decided from the root
 * path itself, not the pointer, so a process whose `$DSH_HOME` already names an
 * account root answers for that account.
 * @returns the account id for a per-account root, or null for the shared home.
 */
function accountOfRoot(): string | null {
  const root = resolveDshHome()
  if (basename(dirname(root)) === DSH_ACCOUNTS_DIR_NAME) return basename(root)
  return readAccountPointer(root)?.firstOwnerUid ?? null
}
