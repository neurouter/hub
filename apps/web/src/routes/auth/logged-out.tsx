import { Link, createFileRoute } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/auth/logged-out')({ component: LoggedOut });

function LoggedOut() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">You're signed out</CardTitle>
          <CardDescription>Close this tab or sign in again.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" render={<Link to="/auth/login" />}>
            Sign in
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
