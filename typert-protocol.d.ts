/**
 * TYPE-ONLY stub for `@deepseek-ai/dsh-typert-protocol`.
 *
 * Why this file exists
 * --------------------
 * R1 §4.4 hard constraint 2: the plugin must NOT carry its own runtime copy of
 * `@deepseek-ai/dsh-typert-protocol` — a second instance of `TypertRemoteService`
 * (and therefore of the Cordis `Service` base it extends) silently disables the
 * Remote layer. So the package declares it only as a peerDependency and the
 * codegen workspace never installs it.
 *
 * The Typert generator still has to *see* the protocol's types, though, both to
 * recognise `TypertRemoteService`/`@Remote` (`analyzer.ts` `isTypeMetaSymbol`)
 * and to typecheck `src/`. The upstream generator fixture solves this the same
 * way (`packages/typert/generator/tests/fixtures/remote-model/typert-protocol.d.ts`),
 * and the generator's `isTypeMetaSymbol` explicitly accepts the ambient
 * `declare module '<name>'` form.
 *
 * Consequently this file is a *declaration* only: it is never emitted, never
 * imported at runtime, and never shipped (`files` in the package manifest does
 * not include it). The declarations below mirror the published
 * `@deepseek-ai/dsh-typert-protocol@0.1.5-rc.2` surface that this package uses.
 *
 * Honest limitation: because this is a hand-maintained stub, a signature drift
 * in the real protocol is caught at runtime, not by `tsc`. See the evidence
 * report for the alternative (install the peer locally and accept a duplicate).
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  /** Type-level association between a Host object and its wire identity. */
  export interface TypertLookup<Host, Wire> {
    readonly host: Host
    readonly wire: Wire
  }

  /** Type-level association between a scoped Context kind and its wire identity. */
  export interface TypertContext<Wire> {
    readonly wire: Wire
  }

  /** Lookup declarations contributed by domain packages. */
  export interface TypertLookupMap {}
  /** Context declarations contributed by domain packages. */
  export interface TypertContextMap {}
  /** Remote endpoints contributed by generated Host artifacts. */
  export interface TypertRemoteMap {}
  /** Namespace index contributed by generated Host artifacts. */
  export interface TypertRemoteNamespaceMap {}

  /** Owner-side business and carrier failure codes. */
  export interface RemoteErrorDetailsMap {
    /** Owner-side business validation refused the request. */
    'gateway/bad-request': { readonly issues?: readonly object[] }
    /** The call was cancelled by the carrier signal or the backend. */
    'gateway/cancelled': {}
    /** Carrier, dispatch, or unclassified Host failure. */
    'gateway/internal': {}
  }

  /** Every declared Remote failure code. */
  export type RemoteErrorCode = keyof RemoteErrorDetailsMap

  /** One Remote call's failure, discriminated by `code`. */
  export type RemoteFailure = {
    [Code in RemoteErrorCode]: RemoteError<Code>
  }[RemoteErrorCode]

  /** What every generated Remote method resolves to on the consumer side. */
  export type RemoteResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RemoteFailure }

  /** Consumer-side invocation descriptors generated from one Host package. */
  export interface TypertRemoteContribution {
    readonly package: string
    readonly descriptors: readonly unknown[]
  }

  /** One Remote call failure: a real Error carrying its stable code and details. */
  export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
    readonly code: Code
    readonly details: RemoteErrorDetailsMap[Code]
    readonly isDSHRemoteError: true
    constructor(code: Code, message: string, details: RemoteErrorDetailsMap[Code], options?: ErrorOptions)
  }

  /** Structurally identify a RemoteError thrown across module copies. */
  export function remoteErrorOf(value: unknown): RemoteFailure | undefined

  /** Visible Service-to-Gateway binding carried on a live Service instance. */
  export interface TypertGatewayBinding<Service extends object = object> {
    readonly service: Service
    readonly serviceKey: string
    readonly namespace: string
  }

  /** Cordis Service base that exposes its registered name through the Typert Gateway. */
  export abstract class TypertRemoteService {
    /** Visible binding consumed by the Gateway's service discovery. */
    readonly typertRemote: TypertGatewayBinding
    protected constructor(
      ctx: unknown,
      serviceKey: string,
      options?: { readonly namespace?: string },
    )
  }

  /** Bind one visible Service field to a Cordis key and Remote namespace. */
  export function bindTypertRemote<Service extends object>(
    service: Service,
    serviceKey: string,
    options?: { readonly namespace?: string },
  ): TypertGatewayBinding<Service>

  /** Mark a business method as a Remote endpoint. */
  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void
  /** Mark a business method as a Remote endpoint under an explicit export name. */
  export function Remote(exportName: string): <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
  /** Mark a method as a streamed Remote endpoint. */
  export function Remote(options: { readonly mode: 'stream' }): <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
