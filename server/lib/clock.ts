// The server's notion of "now". Review scheduling depends on time, so tests replace it.
let source: () => Date = () => new Date()

export function now(): Date {
  return source()
}

/** Test seam, like setPool. Pass null to restore the real clock. */
export function setClock(next: (() => Date) | null): void {
  source = next ?? (() => new Date())
}
