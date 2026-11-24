import { SLUG_REGEX } from '@neurouter/shared';

/** "Internal Docs (v2)" → "internal-docs-v2": lowercase, single hyphens, ≤ 32 chars (tool prefix `slug__tool`). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}
