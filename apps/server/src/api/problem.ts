import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import {
  PROBLEM_CODES,
  PROBLEM_CONTENT_TYPE,
  problemType,
  toProblemPath,
  type Problem,
  type ProblemCode,
  type ProblemFieldError,
} from '@neurouter/shared';
import { AppError, isAppError } from '../lib/errors.js';

const STATUS_TO_CODE: Record<number, ProblemCode> = Object.fromEntries(
  Object.entries(PROBLEM_CODES).map(([code, v]) => [v.status, code as ProblemCode]),
) as Record<number, ProblemCode>;

function codeForStatus(status: number): ProblemCode {
  return STATUS_TO_CODE[status] ?? (status >= 500 ? 'internal' : 'bad_request');
}

function instanceOf(req: FastifyRequest): string {
  const url = req.raw.url ?? req.url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function buildProblem(code: ProblemCode, req: FastifyRequest, detail?: string, errors?: ProblemFieldError[], status?: number): Problem {
  const def = PROBLEM_CODES[code];
  const p: Problem = {
    type: problemType(code),
    title: def.title,
    status: status ?? def.status,
    code,
    requestId: String(req.id),
    instance: instanceOf(req),
  };
  if (detail) p.detail = detail;
  if (errors && errors.length) p.errors = errors;
  return p;
}

/** Zod issues (from fastify-type-provider-zod) → problem `errors[]`. */
function zodFieldErrors(error: { validation: Array<{ message?: string; instancePath?: string; params?: unknown }> }): ProblemFieldError[] {
  return error.validation.map((v) => {
    const issue = (v.params as { issue?: { path?: PropertyKey[]; code?: string; message?: string } } | undefined)?.issue;
    const path = issue?.path ? toProblemPath(issue.path) : (v.instancePath ?? '').split('/').filter(Boolean);
    return { path, message: issue?.message ?? v.message ?? 'Invalid value', code: issue?.code ?? 'invalid' };
  });
}

/** Maps any thrown error to an RFC 9457 problem (backend §14.1). Exposed for unit tests. */
export function toProblem(err: unknown, req: FastifyRequest): { problem: Problem; headers: Record<string, string>; log: 'none' | 'warn' | 'error' } {
  if (isAppError(err)) {
    return {
      problem: { ...buildProblem(err.code, req, err.message, err.fieldErrors), ...(err.extensions ?? {}) },
      headers: err.headers ?? {},
      log: err.status >= 500 ? 'error' : 'none',
    };
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    const errors = zodFieldErrors(err as unknown as { validation: Array<{ message?: string; instancePath?: string; params?: unknown }> });
    const n = errors.length;
    return { problem: buildProblem('validation_failed', req, `${n} field${n === 1 ? ' is' : 's are'} invalid`, errors), headers: {}, log: 'none' };
  }
  if (isResponseSerializationError(err)) {
    return { problem: buildProblem('internal', req, 'The server produced an invalid response'), headers: {}, log: 'error' };
  }
  const fe = err as Partial<FastifyError> | undefined;
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 500;
  if (status >= 400 && status < 500) {
    const code = fe?.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || fe?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 'bad_request' : codeForStatus(status);
    return { problem: buildProblem(code, req, fe?.message, undefined, status), headers: {}, log: 'none' };
  }
  // never leak internal error messages
  return { problem: buildProblem('internal', req, 'Something went wrong'), headers: {}, log: 'error' };
}

export function sendProblem(reply: FastifyReply, problem: Problem, headers: Record<string, string> = {}): FastifyReply {
  for (const [k, v] of Object.entries(headers)) reply.header(k, v);
  return reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const { problem, headers, log } = toProblem(err, req);
  if (log === 'error') req.log.error({ err }, 'request failed');
  else if (log === 'warn') req.log.warn({ err }, 'request failed');
  return sendProblem(reply, problem, headers);
}

export function notFoundProblem(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendProblem(reply, buildProblem('not_found', req, `No route for ${req.method} ${instanceOf(req)}`));
}

export { AppError };
