import { describe, expect, it } from 'vitest'
import { installPromiseWithResolvers } from '../polyfills'

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
  }
}

describe('Promise.withResolvers compatibility', () => {
  it('installs a deferred promise implementation when the API is missing', async () => {
    const promiseConstructor = Promise as PromiseConstructorWithResolvers
    const native = promiseConstructor.withResolvers
    try {
      Object.defineProperty(promiseConstructor, 'withResolvers', {
        configurable: true,
        writable: true,
        value: undefined,
      })
      installPromiseWithResolvers()
      const deferred = promiseConstructor.withResolvers!<number>()
      deferred.resolve(42)
      await expect(deferred.promise).resolves.toBe(42)
    } finally {
      Object.defineProperty(promiseConstructor, 'withResolvers', {
        configurable: true,
        writable: true,
        value: native,
      })
    }
  })
})
