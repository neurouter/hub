import { api } from '@neurouter/shared';
import type { PickerOption } from '@/components/filters/entity-picker';
import { apiFetch } from '@/lib/api-client';

/** Server-side searches backing the filter / grant pickers (frontend §5.3 facets). */
export const pickerSearch = {
  users: async (q: string, signal: AbortSignal): Promise<PickerOption[]> =>
    (await apiFetch(api.users.list, { query: { q: q || undefined, limit: 20 }, signal })).items.map((u) => ({ id: u.id, name: u.name, hint: u.email })),
  agents: async (q: string, signal: AbortSignal): Promise<PickerOption[]> =>
    (await apiFetch(api.agents.list, { query: { owner: 'all', q: q || undefined, limit: 20 }, signal })).items.map((a) => ({ id: a.id, name: a.name, hint: `owner ${a.owner.name}` })),
  myAgents: async (q: string, signal: AbortSignal): Promise<PickerOption[]> =>
    (await apiFetch(api.agents.list, { query: { owner: 'me', q: q || undefined, limit: 50 }, signal })).items.map((a) => ({ id: a.id, name: a.name })),
  servers: async (q: string, signal: AbortSignal): Promise<PickerOption[]> =>
    (await apiFetch(api.servers.list, { query: { q: q || undefined, limit: 50 }, signal })).items.map((s) => ({ id: s.id, name: s.name, hint: s.slug })),
  tools: (serverId?: string) => async (q: string, signal: AbortSignal): Promise<PickerOption[]> =>
    (await apiFetch(api.tools.list, { query: { q: q || undefined, ...(serverId ? { serverId: [serverId] } : {}), limit: 50 }, signal })).items.map((t) => ({ id: t.id, name: t.qualifiedName, hint: t.title ?? undefined })),
  groups: async (q: string, signal: AbortSignal): Promise<PickerOption[]> =>
    (await apiFetch(api.groups.list, { query: { q: q || undefined, limit: 50 }, signal })).items.map((g) => ({ id: g.id, name: g.name, ...('source' in g ? { hint: `${g.source} · ${g.memberCount} members` } : {}) })),
};
