import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheckIcon, EyeIcon, EyeOffIcon, TriangleAlertIcon } from 'lucide-react';
import { api, type ApiKey } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { CopyButton } from '@/components/code/copy-button';
import { apiFetch } from '@/lib/api-client';
import { errorMessage } from '@/lib/notify';
import { formatDate } from '@/lib/format';
import { KEY_EXPIRY_OPTIONS, agentKeys, resolveKeyExpiry, type KeyExpiryChoice } from './queries';

/**
 * Create-key dialog with the show-once secret step (§5.1, W2 acceptance):
 * the secret lives only in this component's state. It is never put in the Query/Mutation cache
 * (the request is made with `apiFetch` directly), never logged, and dropped on close.
 */
export function CreateKeyDialog({ agent, open, onOpenChange, onCreated }: { agent: { id: string; name: string }; open: boolean; onOpenChange: (open: boolean) => void; /** hands the secret to the caller's component state (Connect a client) */ onCreated?: (secret: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<KeyExpiryChoice>('90');
  const [customDate, setCustomDate] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: ApiKey; secret: string } | null>(null);
  const [revealed, setRevealed] = useState(true);
  const [stored, setStored] = useState(false);

  function reset() {
    setName('');
    setExpiry('90');
    setCustomDate('');
    setError(null);
    setCreated(null);
    setRevealed(true);
    setStored(false);
  }

  function close(next: boolean) {
    if (next) return onOpenChange(true);
    // closing the reveal step requires the acknowledgement checkbox
    if (created && !stored) return;
    reset();
    onOpenChange(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const expiresAt = resolveKeyExpiry(expiry, customDate);
    if (!name.trim()) return setError('Name the key so you can recognise it later.');
    if (expiresAt === undefined) return setError('Pick an expiry date in the future.');
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch(api.agents.createKey, { params: { id: agent.id }, body: { name: name.trim(), expiresAt } });
      setCreated(res);
      onCreated?.(res.secret);
      void qc.invalidateQueries({ queryKey: agentKeys.keys(agent.id) });
      void qc.invalidateQueries({ queryKey: agentKeys.detail(agent.id), exact: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[540px]" showCloseButton={!created}>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleCheckIcon className="size-5 text-success" aria-hidden="true" />
                Key “{created.key.name}” created
              </DialogTitle>
              <DialogDescription>
                Agent {agent.name} · {created.key.expiresAt ? `expires ${formatDate(created.key.expiresAt)}` : 'never expires'}
              </DialogDescription>
            </DialogHeader>
            <div role="alert" className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning-muted px-3.5 py-3 text-warning">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold">This is the only time the key is shown.</span>
                <span className="text-[13px] text-foreground">Store it in your secret manager now. Neurouter keeps only a hash and the prefix.</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="api-key-secret">API key</Label>
              <div className="flex items-center overflow-hidden rounded-lg border border-input">
                <input
                  id="api-key-secret"
                  readOnly
                  value={revealed ? created.secret : `${created.secret.slice(0, 12)}${'•'.repeat(Math.max(8, created.secret.length - 12))}`}
                  className="h-9 min-w-0 flex-1 bg-muted/40 px-3 font-mono text-[13px] outline-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="ghost" size="icon" className="h-9 w-10 rounded-none border-l" aria-label={revealed ? 'Hide key' : 'Show key'} onClick={() => setRevealed((v) => !v)}>
                  {revealed ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
                <CopyButton value={created.secret} label="Copy" size="sm" className="h-9 rounded-none border-l" />
              </div>
              <span className="text-xs text-muted-foreground">
                Use as <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>, ideally via <span className="font-mono">{'${NEUROUTER_API_KEY}'}</span>.
              </span>
            </div>
            <label className="flex cursor-pointer items-center gap-2.5 text-sm">
              <Checkbox checked={stored} onCheckedChange={(v) => setStored(Boolean(v))} />
              I've stored this key somewhere safe
            </label>
            <DialogFooter className="sm:justify-between">
              <Link to="/connect" search={{ agentId: agent.id, auth: 'api_key' }} className="self-center text-[13.5px] font-medium underline-offset-4 hover:underline">
                Use it: Connect a client →
              </Link>
              <Button disabled={!stored} onClick={() => close(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="contents">
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>For {agent.name}. The key is shown once after creation.</DialogDescription>
            </DialogHeader>
            <Field data-invalid={!!error && !name.trim()}>
              <FieldLabel htmlFor="key-name">Name</FieldLabel>
              <Input id="key-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="ci-prod" autoComplete="off" />
              <FieldDescription>Where it's used, e.g. “ci-prod” or “laptop”.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="key-expiry">Expires</FieldLabel>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as KeyExpiryChoice)} items={KEY_EXPIRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}>
                <SelectTrigger id="key-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KEY_EXPIRY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {expiry === 'custom' ? (
              <Field>
                <FieldLabel htmlFor="key-date">Expiry date</FieldLabel>
                <Input id="key-date" type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
              </Field>
            ) : null}
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner /> : null}
                Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
