/**
 * Only call and return the result of `f` if `obj` is defined (not null nor
 * undefined)
 */
export function map<T, R>(
  obj: T | undefined | null,
  f: (t: T) => R
): R | undefined {
  return obj != null ? f(obj) : undefined
}

export function isFunction(obj: any): obj is () => any {
  return typeof obj === "function"
}

export function orElse<T>(obj: T | undefined, defaultValue: T | (() => T)): T {
  return obj != null
    ? obj
    : isFunction(defaultValue)
    ? defaultValue()
    : defaultValue
}

export function fromEntries(arr: [string | undefined, any][]) {
  const o: any = {}
  for (const [key, value] of arr) {
    if (key != null) {
      o[key] = value
    }
  }
  return o
}
