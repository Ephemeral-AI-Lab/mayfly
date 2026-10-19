/**
 * Stable identity for services read through `ctx.get`. Cordis wraps every
 * traceable service (anything mounted by a `Service` subclass) in a fresh
 * per-access proxy, so strict equality cannot tell whether the same service is
 * still mounted. The proxy exposes its underlying service at
 * `symbols.original`; non-traceable values (plain test fakes) are their own
 * identity.
 * @module @ephemeral-ai/mayfly/internal/service-identity
 */

import { symbols } from '@deepseek-ai/cordis'

/**
 * Unwrap the proxy Cordis returns for a traceable service.
 * @param service - a service read through `ctx.get`, or a plain object.
 * @returns the underlying service, or the value itself when it has no proxy.
 */
export function serviceIdentity<T extends object>(service: T): object {
  return (Reflect.get(service, symbols.original) as object | undefined) ?? service
}

/**
 * Whether two service reads name the same mounted service, even when Cordis
 * returned a different per-access proxy for each.
 * @param left - first service read, or undefined when unmounted.
 * @param right - second service read, or undefined when unmounted.
 * @returns whether both reads name the same service.
 */
export function sameService(left: object | undefined, right: object | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return serviceIdentity(left) === serviceIdentity(right)
}
