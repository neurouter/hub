/** Tool naming (backend plan §5.5): `<server-slug>__<upstream-tool>`. */
export const TOOL_SEPARATOR = '__';
/** 1–32 chars, lowercase alphanumerics and single hyphens inside; no `_`, so the first `__` splits unambiguously. */
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const MAX_TOOL_NAME = 128;
/** Spec SHOULD for tool names. */
export const TOOL_NAME_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

/** Builds the exposed name, or returns null when it would violate the spec SHOULDs (caller assigns an alias). */
export function buildExposedName(slug: string, upstreamName: string): string | null {
  if (!isValidSlug(slug)) throw new Error(`Invalid server slug: ${slug}`);
  const name = `${slug}${TOOL_SEPARATOR}${upstreamName}`;
  return TOOL_NAME_REGEX.test(name) ? name : null;
}

/** Fast-path split on the FIRST `__`. Resolution must still go through `tools.exposed_name`. */
export function parseExposedName(exposed: string): { slug: string; tool: string } | null {
  const i = exposed.indexOf(TOOL_SEPARATOR);
  if (i <= 0) return null;
  const slug = exposed.slice(0, i);
  const tool = exposed.slice(i + TOOL_SEPARATOR.length);
  if (!isValidSlug(slug) || tool.length === 0) return null;
  return { slug, tool };
}
