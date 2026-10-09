import type { ApiErrorCode } from '../../src/api/contracts'

export class ApiError extends Error {
  status: number
  code: ApiErrorCode

  constructor(message: string, status: number, code: ApiErrorCode) {
    super(message)
    this.status = status
    this.code = code
  }
}
