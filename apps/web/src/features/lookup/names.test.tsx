import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GROUPS, SERVER_IDS } from '@/mocks/demo-data';
import { filterLabels } from '@/features/audit/search';
import { renderRoute } from '@/test/render';
import { missingIds } from './names';

describe('filter chip names after reload (id-only URLs)', () => {
  it('missingIds skips empty, known and duplicate ids and sorts', () => {
    filterLabels.set('known', 'Known');
    expect(missingIds(['b', undefined, 'known', 'a', 'b', null, ''])).toEqual(['a', 'b']);
    filterLabels.delete('known');
  });

  it('resolves a server chip on the tools page with one lookup call', async () => {
    filterLabels.clear();
    const calls: string[][] = [];
    await renderRoute(`/admin/tools?server=${SERVER_IDS.github}`, {
      fixtures: {
        'system.names': ({ request }: { request: Request }) => {
          const ids = new URL(request.url).searchParams.getAll('ids');
          calls.push(ids);
          return { names: { [SERVER_IDS.github]: { type: 'server', name: 'github' } } };
        },
      },
    });
    await waitFor(() => expect(screen.getAllByText(/github/).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByText(new RegExp(SERVER_IDS.github.slice(0, 8)))).not.toBeInTheDocument());
    expect(calls).toEqual([[SERVER_IDS.github]]);
  });

  it('ids the viewer may not see stay as short ids', async () => {
    filterLabels.clear();
    await renderRoute(`/admin/users?groupId=${GROUPS.sre.id}`, { fixtures: { 'system.names': { names: {} } } });
    expect(await screen.findByText(new RegExp(GROUPS.sre.id.slice(0, 8)))).toBeInTheDocument();
  });

  it('resolves a group chip on the users page', async () => {
    filterLabels.clear();
    await renderRoute(`/admin/users?groupId=${GROUPS.sre.id}`);
    await waitFor(() => expect(filterLabels.get(GROUPS.sre.id)).toBe('sre'));
    expect(screen.queryByText(new RegExp(GROUPS.sre.id.slice(0, 8)))).not.toBeInTheDocument();
  });
});
