import { PROBLEM_CODES, type ProblemCode, type ProblemFieldError } from '@neurouter/shared';

/**
 * Application error rendered as RFC 9457 problem+json by the API error handler.
 * `code` picks the status/title/type from the shared catalog unless overridden.
 */
export class AppError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly title: string;
  readonly fieldErrors?: ProblemFieldError[];
  readonly headers?: Record<string, string>;
  readonly extensions?: Record<string, unknown>;

  constructor(
    code: ProblemCode,
    detail?: string,
    opts: { fieldErrors?: ProblemFieldError[]; headers?: Record<string, string>; extensions?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(detail ?? PROBLEM_CODES[code].title, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = PROBLEM_CODES[code].status;
    this.title = PROBLEM_CODES[code].title;
    if (opts.fieldErrors) this.fieldErrors = opts.fieldErrors;
    if (opts.headers) this.headers = opts.headers;
    if (opts.extensions) this.extensions = opts.extensions;
  }

  static unauthenticated(detail = 'Sign in to continue') { return new AppError('unauthenticated', detail); }
  static forbidden(detail = 'You do not have permission to perform this action') { return new AppError('forbidden', detail); }
  static notFound(what = 'Resource') { return new AppError('not_found', `${what} not found`); }
  static conflict(detail: string) { return new AppError('conflict', detail); }
  static gone(detail: string) { return new AppError('gone', detail); }
  static validation(detail: string, fieldErrors: ProblemFieldError[] = []) { return new AppError('validation_failed', detail, { fieldErrors }); }
  static rateLimited(retryAfterSec: number) {
    return new AppError('rate_limited', `Rate limited, retry in ${retryAfterSec} s`, { headers: { 'retry-after': String(retryAfterSec) } });
  }
  static internal(detail = 'Something went wrong', cause?: unknown) { return new AppError('internal', detail, { cause }); }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
