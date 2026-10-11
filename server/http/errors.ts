import type { ApiErrorCode } from '../../src/api/contracts'

export class ApiError extends Error {
  status: number
  code: ApiErrorCode
  /** Extra top-level response fields (for example the saved copy on a notes conflict). */
  extra?: Record<string, unknown>

  constructor(message: string, status: number, code: ApiErrorCode, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}
