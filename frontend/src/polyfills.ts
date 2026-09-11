type PromiseWithResolvers<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => PromiseWithResolvers<T>
}

/**
 * PDF.js 4.x uses Promise.withResolvers, which is missing from older Safari
 * versions still supported by the iOS app. Install the native-compatible
 * implementation before any lazily loaded PDF.js code runs.
 */
export function installPromiseWithResolvers(): void {
  const promiseConstructor = Promise as PromiseConstructorWithResolvers
  if (typeof promiseConstructor.withResolvers === 'function') return

  Object.defineProperty(promiseConstructor, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers<T>(): PromiseWithResolvers<T> {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      return { promise, resolve, reject }
    },
  })
}

installPromiseWithResolvers()
