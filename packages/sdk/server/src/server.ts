/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SessionResumeParams,
  SessionWaitParams,
  SessionWorkingDirectoryParams,
  SessionWorkingDirectorySetParams,
  SessionWorkingDirectoryResult,
  SdkEncodedImageBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
  /** Latest live failure not superseded by a subsequently committed terminal. */
  failure: { readonly error: unknown; readonly atOffset: SessionLogOffset } | undefined
}

function encodedImage(block: SessionPromptParams['contentBlocks'][number]): block is SdkEncodedImageBlock {
  return block.type === 'image' && 'data' in block
}

async function durablePromptContent(ctx: Context, blocks: SessionPromptParams['contentBlocks']): Promise<ContentBlock[]> {
  const images = blocks.filter(encodedImage)
  if (images.length === 0) return blocks as ContentBlock[]
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('SDK image prompt requires an attachment store')
  const refs = await admitEncodedImages(attachments, images.map((image): EncodedImageAttachment => ({
    data: image.data,
    mediaType: image.mimeType,
  })))
  let next = 0
  return blocks.map(block => encodedImage(block)
    ? { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
    : block)
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

/** `approval/request` host call parameters for one tool approval. */
export interface ApprovalRequestParams {
  /** Session that triggered the approval. */
  sessionId: string
  /** SDK-owned root session of `sessionId`, present only for subagent descendants. */
  rootSessionId?: string
  /** Tool awaiting approval. */
  toolName: string
  /** Tool call awaiting approval, when the request carries one. */
  callId?: string
  /** Model-facing reason the tool needs approval. */
  reason?: string
}

/** `user-question/ask` host call parameters for one pending question set. */
export interface UserQuestionAskParams {
  /** Correlation id echoed by `user-question.cancelled` on abort. */
  requestId: string
  /** Session whose tool call is waiting for the answer. */
  sessionId: string
  /** Questions the host must answer, one answer per id. */
  questions: AskUserQuestionRequestEvent['questions']
}

/** `user-question.cancelled` host notification sent when the question lifetime ends. */
export interface UserQuestionCancelledNotification {
  /** Correlation id from the matching `user-question/ask`. */
  requestId: string
  /** Session whose question was cancelled. */
  sessionId: string
}

/**
 * One JSON-RPC method contributed by a profile plugin.
 * @param params - request params; an absent params member arrives as `{}`.
 * @param signal - aborts when this server shuts down.
 * @returns the JSON-RPC result; `undefined` is reported to the host as `{}`.
 */
export type SdkExtensionHandler = (params: Record<string, unknown>, signal: AbortSignal) => unknown | Promise<unknown>

/** JSON-RPC methods a profile plugin serves beside this server's own surface. */
export interface SdkExtensionRegistry {
  /**
   * @param method - JSON-RPC request method name.
   * @returns the handler claiming `method`, or `undefined` when no plugin contributes it.
   */
  resolve(method: string): SdkExtensionHandler | undefined
  /** @returns every contributed method name. */
  methods(): string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** An SDK prompt carrying the correlation id and zone that time-aware request context reads. */
    'user-sdk': { kind: 'user'; rpcId: string; clientTimeZone?: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** SDK JSON-RPC methods contributed by profile plugins; absent when none is loaded. */
    sdkExtensions?: SdkExtensionRegistry
  }

  interface Events {
    /**
     * Forward a plugin-contributed notification to the SDK client.
     * @param method - JSON-RPC notification method name.
     * @param params - notification params.
     * @mode emit
     */
    'sdk-extensions/notify'(method: string, params: Record<string, unknown>): void

    /**
     * Claim a JSON-RPC method this server's own surface does not implement.
     * @param method - JSON-RPC request method name.
     * @mode bail
     */
    'sdk-extensions/resolve'(method: string): SdkExtensionHandler | undefined
  }
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private initialized = false
  private approvalRequests = false
  private userQuestionsEnabled = false
  private readonly lifetime = new AbortController()

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('approval/request', async (request, next): Promise<ApprovalOutcome> => {
      if (!this.approvalRequests) return next()
      const sessionId = String(request.agent.session.id)
      const rootSessionId = this.ownedRootSessionId(request.agent)
      if (rootSessionId === undefined) return next()
      const params: ApprovalRequestParams = {
        sessionId,
        ...rootSessionId === sessionId ? {} : { rootSessionId },
        toolName: request.toolName,
        ...request.callId === undefined ? {} : { callId: request.callId },
        ...request.reason === undefined ? {} : { reason: request.reason },
      }
      const signal = request.signal === undefined
        ? this.lifetime.signal
        : AbortSignal.any([request.signal, this.lifetime.signal])
      const result = await this.transport.request('approval/request', params, signal)
      if (result === null || typeof result !== 'object' || !('outcome' in result)
        || (result.outcome !== 'allowed-once' && result.outcome !== 'rejected' && result.outcome !== 'cancelled')) {
        throw new TypeError('approval/request response requires an allowed-once, rejected, or cancelled outcome')
      }
      return result.outcome
    }))
    this.disposers.push(ctx.on('user-questions/request', async (request, next) => {
      const agent = request.agent
      if (!this.userQuestionsEnabled || agent === undefined || this.ownedRootSessionId(agent) === undefined) return next()
      return this.askUserQuestion(request, String(agent.session.id))
    }))
    this.disposers.push(ctx.on('sdk-extensions/notify', (method, params) => {
      if (method.length === 0 || this.shuttingDown) return
      try {
        this.transport.notify(method, params)
      } catch (error) {
        // The transport is already closed; the emitting plugin must not fail for it.
      }
    }))
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const record = this.sessions.get(session.id)
      if (event.type === 'turn/end' && record?.handle.agent.session === session
        && record.failure !== undefined && event.seq >= record.failure.atOffset) {
        record.failure = undefined
      }
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const record = this.sessions.get(agent.session.id)
      if (record?.handle.agent !== agent) return
      record.failure = { error, atOffset: agent.session.seq }
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // A turn that ends in failure stops the driver with steering still
      // unclaimed; dsh would hand it to whatever prompt arrives next. Replay it
      // as a turn of its own once this idle report has been published.
      if (status !== 'idle' || !this.ownsAgent(agent)) return
      setImmediate(() => {
        if (!this.shuttingDown && this.ownsAgent(agent)) agent.wake()
      })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined
          ? {}
          : { lastAssistantMessage: [...info.lastAssistantMessage] }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Validate and configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.approvalRequests !== undefined && typeof params.approvalRequests !== 'boolean') {
      throw new TypeError('initialize approvalRequests must be a boolean')
    }
    if (params.reasoningEffort !== undefined
      && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.length === 0)) {
      throw new TypeError('initialize reasoningEffort must be a non-empty string')
    }
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const cwd = resolve(params.cwd)
    const provider = params.provider
    const model = params.model
    const reasoningEffort = params.reasoningEffort === undefined
      ? undefined
      : ReasoningEffortId(params.reasoningEffort)
    if (!this.hasAdapterFor(provider)) {
      if (provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek)
    }
    // Adapter presence was read from this service above; a successful fallback mount also requires it.
    const llm = this.ctx.get('llm') as LlmRuntime
    await llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens },
    })
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.maxTokens = params.maxTokens
    this.approvalRequests = params.approvalRequests === true
    this.userQuestionsEnabled = params.capabilities?.userQuestions === true
    this.initialized = true
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Deliver one identified prompt without assigning later activity to it. A
   * `steer` prompt joins the running turn at its next step boundary; every
   * other prompt, and a `steer` while the Agent is idle, queues a turn.
   * @param params - target session, user content, and delivery mode.
   * @returns the durable message identity and the delivery it received.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery.
    this.assertLiveAgent(rec, params.sessionId)
    const content = await durablePromptContent(this.ctx, params.contentBlocks)
    // Attachment admission crosses an async boundary where shutdown or an
    // agent-loop reload may detach the retained handle.
    this.assertLiveAgent(rec, params.sessionId)
    const clientTimeZone = params.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(params.clientTimeZone)
    const message = createUserMessage({
      content,
      source: {
        kind: 'user',
        rpcId: randomUUID(),
        ...clientTimeZone === undefined ? {} : { clientTimeZone },
      },
    })
    // Read the status after every await so the branch matches the moment of
    // delivery: steering an idle Agent would otherwise open the turn as a
    // step input that no running step can claim.
    const steer = promptMode(params.mode) === 'steer' && rec.handle.agent.status === 'running'
    if (steer) rec.handle.agent.steer(message)
    else rec.handle.agent.followup(message)
    return { messageId: message.id, delivery: steer ? 'step' : 'turn' }
  }

  /**
   * Restore a persisted session and repair its interrupted final turn without sending input.
   * Uses the initialized model route while preserving the stored session identity and directory.
   * Rejects missing, unreadable, or already owned sessions; never creates a replacement.
   * Pending inbox input a dead process never claimed is dropped once the
   * restored Agent is idle, so the next prompt cannot deliver it beside its own
   * message.
   * @param params - persisted session identity in the configured persistence store.
   * @returns an empty result after the Agent is ready for prompts.
   */
  async resume(params: SessionResumeParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const sessionId = params.sessionId
    if (this.sessions.has(sessionId) || this.sessionCreations.has(sessionId)) {
      throw new Error(`SDK session is already open or opening: ${sessionId}`)
    }
    const rec = await this.openSession(sessionId, true)
    const agent = rec.handle.agent
    if (agent.status === 'idle'
      && (agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0)) {
      agent.inbox.clear()
    }
    return {}
  }

  /**
   * Wait for an existing owned Agent and its managed descendants to finish.
   * The response follows all Session notifications emitted during the wait.
   * Rejects a live Agent failure that has no subsequent durable terminal.
   * @param params - the SDK-owned session to observe without creating one.
   * @returns an empty result after the root stays idle across the descendant check.
   */
  async wait(params: SessionWaitParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = this.sessions.get(params.sessionId)
    if (rec === undefined) throw new Error(`unknown SDK session: ${params.sessionId}`)
    const agent = rec.handle.agent
    const subagents = this.ctx.get('subagents')
    while (true) {
      this.assertLiveAgent(rec, params.sessionId)
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      const children = await subagents?.waitForChildren(agent)
      this.assertLiveAgent(rec, params.sessionId)
      if (!children && agent.status === 'idle' && agent.session.seq === idleSeq) {
        if (rec.failure !== undefined) throw rec.failure.error
        return {}
      }
    }
  }

  /**
   * Whether this server still drives exactly this agent for its own session id.
   * @param agent - the agent whose status was reported.
   * @returns true when the session record and the live registry both name this agent.
   */
  private ownsAgent(agent: Agent): boolean {
    const record = this.sessions.get(String(agent.session.id))
    return record?.handle.agent === agent && this.ctx.agents.get(agent.id) === agent
  }

  /**
   * The SDK-created root session of `agent`, including `agent` itself.
   * @param agent - the agent carried by an approval or question request.
   * @returns the root session id, or `undefined` when this server owns no ancestor.
   */
  private ownedRootSessionId(agent: Agent): string | undefined {
    const agents = this.ctx.agents
    if (agents.get(agent.id) !== agent) return undefined
    const liveAgents = agents.list()
    const ancestors = new Set([agent])
    for (const current of ancestors) {
      if (this.sessions.get(String(current.session.id))?.handle.agent === current) return String(current.session.id)
      for (const parent of liveAgents) if (agents.isOwnedBy(current.id, parent)) ancestors.add(parent)
    }
    return undefined
  }

  /**
   * Ask the SDK host to answer one question set, validating its reply against the asked ids.
   * @param request - the pending user question.
   * @param sessionId - session whose tool call is waiting for the answer.
   * @returns answers for every asked question id.
   */
  private async askUserQuestion(request: AskUserQuestionRequestEvent, sessionId: string): Promise<AskUserQuestionAnswer> {
    const params: UserQuestionAskParams = {
      requestId: randomUUID(),
      sessionId,
      questions: request.questions,
    }
    const signal = request.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([request.signal, this.lifetime.signal])
    if (signal.aborted) throw new UserQuestionError('SDK user question was cancelled', 'ASK_ABORTED')
    const cancelled = (): void => {
      const payload: UserQuestionCancelledNotification = { requestId: params.requestId, sessionId }
      try {
        this.transport.notify('user-question.cancelled', payload)
      } catch (error) {
        // The host is already unreachable; the request rejection reports the abort.
      }
    }
    signal.addEventListener('abort', cancelled, { once: true })
    try {
      const value = await this.transport.request('user-question/ask', params, signal)
      const ids = request.questions.map(question => question.id)
      const bad = (): UserQuestionError => new UserQuestionError(
        'SDK host must answer each question id exactly once with selected labels and optional custom text',
        'BAD_ANSWER',
      )
      if (value === null || typeof value !== 'object' || !('answers' in value) || !Array.isArray(value.answers)) throw bad()
      const isLabels = (candidate: unknown): candidate is string[] =>
        Array.isArray(candidate) && candidate.every(label => typeof label === 'string')
      const answers = value.answers.map((answer: unknown): AskUserQuestionAnswer['answers'][number] => {
        if (answer === null || typeof answer !== 'object') throw bad()
        const { id, selected, custom } = answer as { id?: unknown, selected?: unknown, custom?: unknown }
        if (typeof id !== 'string' || !isLabels(selected) || (custom !== undefined && typeof custom !== 'string')) throw bad()
        return {
          id,
          selected,
          ...custom === undefined ? {} : { custom },
        }
      })
      const seen = new Set(answers.map(answer => answer.id))
      if (seen.size !== answers.length || answers.length !== ids.length || !ids.every(id => seen.has(id))) throw bad()
      return { answers }
    } catch (error) {
      if (error instanceof UserQuestionError) throw error
      throw new UserQuestionError(
        signal.aborted ? 'SDK user question was cancelled' : 'SDK host could not answer the user question',
        signal.aborted ? 'ASK_ABORTED' : 'PROVIDER_ERROR',
        { cause: error },
      )
    } finally {
      signal.removeEventListener('abort', cancelled)
    }
  }

  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /**
   * Read a Session's effective directory, recovering a missing directory to its origin.
   * @param params - target Session; an unknown id creates it.
   * @returns the absolute effective directory.
   */
  async getWorkingDirectory(params: SessionWorkingDirectoryParams): Promise<SessionWorkingDirectoryResult> {
    const agent = await this.workingDirectoryAgent(params.sessionId)
    return { cwd: await this.ctx.workingDirectory.ensure(agent) }
  }

  /**
   * Change a Session's directory and queue its model-visible transition.
   * @param params - target Session and absolute or current-directory-relative path.
   * @returns the validated absolute directory; origin and permissions are unchanged.
   */
  async setWorkingDirectory(params: SessionWorkingDirectorySetParams): Promise<SessionWorkingDirectoryResult> {
    const agent = await this.workingDirectoryAgent(params.sessionId)
    return { cwd: await this.ctx.workingDirectory.set(agent, params.path) }
  }

  private async workingDirectoryAgent(sessionId: string): Promise<Agent> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(sessionId)
    this.assertLiveAgent(rec, sessionId)
    return rec.handle.agent
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * Managed descendants drain before the root Agent handles and adapter are released.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    this.approvalRequests = false
    this.userQuestionsEnabled = false
    this.lifetime.abort(new Error('SDK server is shutting down'))
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await this.ctx.get('subagents')?.drainDescendants(records.map(rec => rec.handle.agent))
    } catch (error: unknown) {
      failures.push(error)
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/resume': {
        const sessionId = params?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new TypeError('session/resume requires a non-empty sessionId string')
        }
        return this.resume({ sessionId })
      }
      case 'session/wait': {
        const sessionId = params?.sessionId
        if (typeof sessionId !== 'string') throw new TypeError('session/wait requires a sessionId string')
        return this.wait({ sessionId })
      }
      case 'session/working-directory/get':
      case 'session/working-directory/set': {
        if (typeof params?.sessionId !== 'string' || params.sessionId.length === 0) {
          throw new TypeError('working-directory requests require a non-empty sessionId')
        }
        if (method === 'session/working-directory/get') {
          return this.getWorkingDirectory({ sessionId: params.sessionId })
        }
        if (typeof params.path !== 'string') throw new TypeError('working-directory set requires a path string')
        return this.setWorkingDirectory({ sessionId: params.sessionId, path: params.path })
      }
      case 'shutdown':
        return this.shutdown()
      default: {
        // Profile plugins contribute methods that need no `initialize`; settle
        // the Loader like the handshake does before resolving them.
        await this.ctx.get('loader')?.await()
        const extension = this.ctx.get('sdkExtensions')?.resolve(method)
          ?? this.ctx.bail('sdk-extensions/resolve', method)
        if (extension === undefined) throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
        const result = await extension(params ?? {}, this.lifetime.signal)
        return result ?? {}
      }
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    return this.openSession(sessionId, false)
  }

  private openSession(sessionId: string, resume: boolean): Promise<SessionRecord> {
    const creation = this.createSession(sessionId, resume)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string, resume: boolean): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
    }
    const handle = await (resume ? this.ctx.agents.resume({
      resumeSessionId: brandString<SessionId>(sessionId),
      agentOptions,
    }) : this.ctx.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: { cwd: this.cwd },
      agentOptions,
    }))
    const rec: SessionRecord = { handle, failure: undefined }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}

/**
 * Narrow the wire value of {@link SessionPromptParams.mode} to a known delivery.
 * @param value - omitted, or the requested delivery from the caller.
 * @returns the delivery to decide between steering and queueing a turn.
 */
function promptMode(value: SessionPromptParams['mode']): 'followup' | 'steer' {
  if (value === undefined || value === 'followup') return 'followup'
  if (value === 'steer') return 'steer'
  throw new TypeError('session/prompt mode must be "followup" or "steer"')
}
