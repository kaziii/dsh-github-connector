/**
 * Hand-written Typert Remote contribution for the `githubConnect` namespace,
 * mounted by this package's client half through `ctx.remote.$mount`
 * (ADR-0008/ADR-0009: verified viable for an out-of-repo plugin — the dsh
 * gateway has no namespace whitelist and mounting has no boot-phase
 * restriction). Once the dsh Typert generator runs over
 * `dsh-github-connect`, its `./remote` artifact replaces this module.
 *
 * Two wire contracts this module must keep by hand:
 *
 * 1. Every `wire` field equals the host method's formal parameter name — the
 *    gateway's source-mode discovery derives wire fields from
 *    `Function.prototype.toString()` (`createPr(request)` → `request`).
 * 2. Every codec is `mode: 'strict'` with a callable `parse` — the dsh client
 *    refuses SRC descriptors, and validates each argument and result through
 *    these parsers.
 * @module dsh-ui-github/client/contribution
 */

import type {
  InvocationDescriptor,
  InvocationParameterDescriptor,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'

/** The npm package owning the Remote methods (contributions dedupe by it). */
const OWNER = 'dsh-github-connect'

/** Build one strict codec over a parse function. */
function strict(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  return { mode: 'strict', typeSymbol, schema: { parse } }
}

/** Reject non-object boundary values; field-level shape stays with the host. */
function parseObject(label: string): (value: unknown) => unknown {
  return value => {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError(`${label} must be an object`)
    }
    return value
  }
}

/** Tolerate an absent value (JSON round-trips undefined as null). */
function parseMaybeObject(label: string): (value: unknown) => unknown {
  const required = parseObject(label)
  return value => value === undefined || value === null ? undefined : required(value)
}

/** Void results arrive as undefined or null; anything else is a wire fault. */
function parseVoid(value: unknown): undefined {
  if (value !== undefined && value !== null) {
    throw new TypeError('expected an empty result')
  }
  return undefined
}

/** Build one zero-parameter descriptor. */
function query(method: string, result: TypertCodec): InvocationDescriptor {
  return {
    id: `${OWNER}#githubConnect/${method}`,
    service: 'githubConnect',
    namespace: 'githubConnect',
    method,
    invocation: { kind: 'direct' },
    parameters: [],
    result,
  }
}

/** Build one single-parameter descriptor (wire = host formal name). */
function command(method: string, parameter: InvocationParameterDescriptor, result: TypertCodec): InvocationDescriptor {
  return { ...query(method, result), parameters: [parameter] }
}

const REQUEST: Omit<InvocationParameterDescriptor, 'codec'> = {
  name: 'request',
  wire: 'request',
  source: 'json',
}

/** Reject a present-but-non-string `sessionId` field (ADR-0010); absence is fine. */
function requireSessionIdShape(label: string, request: { sessionId?: unknown }): void {
  if (request.sessionId !== undefined && typeof request.sessionId !== 'string') {
    throw new TypeError(`${label} sessionId must be a string when present`)
  }
}

/** The optional session-carrier request of the zero-business-argument methods (ADR-0010). */
const SESSION_REQUEST: InvocationParameterDescriptor = {
  ...REQUEST,
  acceptsUndefined: true,
  codec: strict('dsh-ui-github#SessionRequest?', value => {
    const request = parseMaybeObject('the session request')(value) as { sessionId?: unknown } | undefined
    if (request !== undefined) requireSessionIdShape('the session request', request)
    return request
  }),
}

/** The `githubConnect` Remote face (mirrors `GitHubConnectService`'s @Remote methods). */
export const GITHUB_CONNECT_REMOTE: TypertRemoteContribution = {
  package: OWNER,
  descriptors: [
    query('connectStatus', strict('dsh-ui-github#ConnectStatus', parseObject('the connect status'))),
    query('startDeviceFlow', strict('dsh-github-connect#DeviceFlowPrompt', parseObject('the device flow prompt'))),
    query('deviceFlowStatus', strict('dsh-github-connect#DeviceFlowUpdate?', parseMaybeObject('the device flow update'))),
    query('disconnect', strict('dsh-ui-github#Void', parseVoid)),
    command('prDraft', SESSION_REQUEST, strict('dsh-github-connect#PrDraft', value => {
      const draft = parseObject('the PR draft')(value) as { title?: unknown }
      if (typeof draft.title !== 'string') throw new TypeError('the PR draft needs a string title')
      return draft
    })),
    command(
      'createPr',
      {
        ...REQUEST,
        codec: strict('dsh-github-connect#CreatePrRequest', value => {
          const request = parseObject('the createPr request')(value) as { title?: unknown, sessionId?: unknown }
          if (typeof request.title !== 'string') throw new TypeError('createPr needs a string title')
          requireSessionIdShape('the createPr request', request)
          return request
        }),
      },
      strict('dsh-github-connect#CreatePrResult', parseObject('the createPr result')),
    ),
    command(
      'mergePr',
      {
        ...REQUEST,
        codec: strict('dsh-github-connect#MergePrRequest', value => {
          const request = parseObject('the mergePr request')(value) as { number?: unknown, method?: unknown, sessionId?: unknown }
          if (typeof request.number !== 'number') throw new TypeError('mergePr needs a numeric PR number')
          if (typeof request.method !== 'string') throw new TypeError('mergePr needs a merge method')
          requireSessionIdShape('the mergePr request', request)
          return request
        }),
      },
      strict('dsh-github-connect#MergePrResult', parseObject('the mergePr result')),
    ),
    {
      ...query('prChecks', strict('dsh-github-connect#ChecksSummary?', value =>
        value === undefined || value === null
          ? undefined
          : (() => {
              if (typeof value !== 'string') throw new TypeError('the checks summary must be a string')
              return value
            })())),
      parameters: [
        {
          name: 'number',
          wire: 'number',
          source: 'json',
          codec: strict('dsh-ui-github#PrNumber', value => {
            if (typeof value !== 'number') throw new TypeError('prChecks needs a numeric PR number')
            return value
          }),
        },
        {
          name: 'sessionId',
          wire: 'sessionId',
          source: 'json',
          acceptsUndefined: true,
          codec: strict('dsh-ui-github#SessionId?', value => {
            if (value === undefined || value === null) return undefined
            if (typeof value !== 'string') throw new TypeError('prChecks sessionId must be a string when present')
            return value
          }),
        },
      ],
    },
    command('refreshFlowState', SESSION_REQUEST, strict('dsh-github-connect#GitHubFlowState', parseObject('the flow state'))),
  ],
}
