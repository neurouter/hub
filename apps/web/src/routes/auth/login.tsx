import { useState, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { LogInIcon } from 'lucide-react';
import { LoginErrorCode, PRODUCT_NAME, api, isSafeReturnTo } from '@neurouter/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { providersQueryOptions } from '@/features/auth/queries';
import { ApiError, apiFetch } from '@/lib/api-client';
import { browserNavigation } from '@/lib/navigation';

const searchSchema = z.object({
  returnTo: z.string().optional().catch(undefined),
  error: LoginErrorCode.optional().catch(undefined),
});

export const LOGIN_ERRORS: Record<z.infer<typeof LoginErrorCode>, string> = {
  access_denied: 'Your identity provider or the gateway denied access.',
  no_account: 'There is no Neurouter account for you yet. Ask an administrator to add you.',
  disabled: 'Your account is disabled.',
  idp_error: 'Sign-in failed at the identity provider. Try again.',
  session_expired: 'Your session expired. Sign in again to continue.',
};

export const Route = createFileRoute('/auth/login')({
  validateSearch: searchSchema,
  component: LoginPage,
});

/** Converts an absolute same-origin href into a path; anything unsafe falls back to "/". */
export function safeReturnPath(returnTo: string | undefined, origin = window.location.origin): string {
  if (!returnTo) return '/';
  let path = returnTo;
  if (returnTo.startsWith(origin)) path = returnTo.slice(origin.length) || '/';
  return isSafeReturnTo(path) && !path.startsWith('/auth/') ? path : '/';
}

function LoginPage() {
  const { returnTo, error } = Route.useSearch();
  const target = safeReturnPath(returnTo);
  const { data } = useQuery(providersQueryOptions());
  const oidc = data?.providers.find((p) => p.id === 'oidc');
  const dev = data?.providers.find((p) => p.id === 'dev');
  const [email, setEmail] = useState('');
  const [devError, setDevError] = useState<string | null>(null);

  async function devLogin(e: FormEvent) {
    e.preventDefault();
    setDevError(null);
    try {
      await apiFetch(api.auth.devLogin, { body: { email } });
      browserNavigation.assign(target);
    } catch (err) {
      setDevError(err instanceof ApiError ? (err.detail ?? err.title) : 'Sign-in failed');
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign in to {data?.productName ?? PRODUCT_NAME}</CardTitle>
          <CardDescription>Use your organization account.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{LOGIN_ERRORS[error]}</AlertDescription>
            </Alert>
          ) : null}
          {oidc ? (
            <Button className="w-full" onClick={() => browserNavigation.assign(`/api/auth/login?returnTo=${encodeURIComponent(target)}`)}>
              <LogInIcon /> Sign in with {oidc.displayName}
            </Button>
          ) : null}
          {dev ? (
            <>
              {oidc ? <Separator /> : null}
              <form className="flex flex-col gap-2" onSubmit={devLogin}>
                <Label htmlFor="dev-email">Development login</Label>
                <Input id="dev-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                {devError ? <p className="text-sm text-destructive">{devError}</p> : null}
                <Button type="submit" variant="outline">
                  Continue
                </Button>
              </form>
            </>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
