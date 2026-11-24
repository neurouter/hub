import { Link, Outlet, createRootRouteWithContext } from '@tanstack/react-router';
import { FileQuestionIcon } from 'lucide-react';
import type { RouterContext } from '@/app/route-guards';
import { EmptyState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';

export function NotFound() {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-16">
      <EmptyState icon={FileQuestionIcon} title="Page not found" description="The page you're looking for doesn't exist or has moved." action={<Button render={<Link to="/" />}>Go home</Button>} />
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
});
