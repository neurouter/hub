import { useState, type ReactNode } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

/**
 * Destructive confirmation (§8): AlertDialog, the destructive action is not focused by default,
 * and optionally the user must type `confirmText` (agent name, server slug) to enable it.
 */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, onConfirm, pending, confirmText, destructive = true, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  confirmText?: string;
  destructive?: boolean;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const blocked = confirmText !== undefined && typed !== confirmText;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('');
        onOpenChange(o);
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        {confirmText !== undefined ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-text">
              Type <span className="font-mono">{confirmText}</span> to confirm
            </Label>
            <Input id="confirm-text" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={blocked || pending} onClick={onConfirm}>
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
