import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type LibraryStatus } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { apiFetch } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { libraryKeys } from './queries';

/** Enable registry sync, set the registry URL and the optional GitHub token (admin). */
export function LibrarySettingsDialog({ status, open, onOpenChange }: { status: LibraryStatus; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(status.enabled);
  const [url, setUrl] = useState(status.registryUrl);
  const [token, setToken] = useState('');
  const save = useMutation({
    mutationFn: (extra: { githubToken?: string | null }) =>
      apiFetch(api.library.updateSettings, { body: { enabled, ...(url !== status.registryUrl ? { registryUrl: url } : {}), ...extra } }),
    onSuccess: (st) => {
      qc.setQueryData(libraryKeys.status(), st);
      void qc.invalidateQueries({ queryKey: libraryKeys.all });
      notifySuccess('Library settings saved');
      setToken('');
      onOpenChange(false);
    },
    onError: (err) => notifyError(err, 'Could not save the library settings'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Library settings</DialogTitle>
          <DialogDescription>The library is a local copy of an MCP registry. Syncing makes hourly outbound requests to the registry URL below.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <Switch id="lib-enabled" checked={enabled} onCheckedChange={setEnabled} />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="lib-enabled">Sync from the registry</Label>
              <span className="text-xs text-muted-foreground">Off by default, so air-gapped installs make no requests. Point the URL at an internal mirror if you need one.</span>
            </div>
          </div>
          <Field>
            <FieldLabel htmlFor="lib-url">Registry URL</FieldLabel>
            <Input id="lib-url" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-[13px]" />
            <FieldDescription>Any registry that implements the MCP registry API (<span className="font-mono">GET /v0.1/servers</span>).</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="lib-token">GitHub token (optional)</FieldLabel>
            <Input id="lib-token" type="password" autoComplete="off" value={token} placeholder={status.hasGithubToken ? 'A token is stored; type to replace it' : 'No token: 60 lookups per hour'} onChange={(e) => setToken(e.target.value)} />
            <FieldDescription>Used by checks to read repository activity, stars and license. A token without scopes is enough.</FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          {status.hasGithubToken ? (
            <Button variant="ghost" className="mr-auto" disabled={save.isPending} onClick={() => save.mutate({ githubToken: null })}>
              Remove token
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate(token ? { githubToken: token } : {})}>
            {save.isPending ? <Spinner /> : null} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
