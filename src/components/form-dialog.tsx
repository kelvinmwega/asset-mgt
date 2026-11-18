"use client";

import {
  useActionState,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * A form in a focused dialog, wrapped around a server action (AM-09 DESIGN §4.3).
 *
 * The sibling of `ConfirmActionDialog`, not a reuse of it. That component is
 * shaped for the destructive path — one irreversible act, a confirm, a result —
 * and everything about its vocabulary says so: `confirmLabel`, `destructive`,
 * "are you sure". A lifecycle form is the opposite case. Receiving a delivery or
 * assigning a laptop is the ordinary work of the register, it takes real input,
 * and framing it as a confirmation would train the operator to click through the
 * one dialog in the app that genuinely means stop.
 *
 * **What it does share is every in-flight guarantee**, because those are about
 * the dialog and not about what it is asking. AM-09 DESIGN §5, guards 2-4:
 *
 *  2. Dismissing NEVER submits. Escape, the overlay, the X and Cancel all close
 *     and do nothing else — `type="button"` on every one of them, because a
 *     bare <button> inside a <form> is a submit button.
 *  3. While the action is in flight the dialog cannot be dismissed at all, the
 *     submit button is disabled, and the fields are frozen. A modal that
 *     vanishes mid-flight leaves the operator with no idea whether it happened.
 *  4. The result is shown, not swallowed — a rejection from the lifecycle guard
 *     ("this asset is already assigned") renders in place, so the operator can
 *     fix the input and retry without losing what they typed.
 *
 * Guard 1 holds too and reads differently here: the trigger opens the dialog and
 * submits nothing. For a confirmation that is the whole point; for a form it is
 * simply that opening a form does not run it.
 *
 * Those guarantees are asserted ONCE, in `test/action-dialog-guards.tsx`, and
 * both this and `ConfirmActionDialog` are run through it. A regression in either
 * fails the same assertion — which is the only way two components can be said to
 * hold the same property rather than to have had it described twice.
 *
 * Like its sibling it does NOT close itself on success: auto-closing would mean
 * reacting to a state change during render, and the page behind has already
 * revalidated, so the dialog is reporting rather than blocking.
 */

/** The shape `AssetActionState` and `UserActionState` already have. */
export type FormDialogState = { ok: boolean; message: string } | null;

/**
 * How an action dialog opens: from its own trigger, which opens it and submits
 * nothing, or from outside. A dialog chosen from a menu cannot live inside the
 * menu, whose content unmounts as the menu closes (custom-dropdowns G10), so
 * its owner holds `open` and names where focus goes back on close — Radix
 * returns focus to a trigger, and this dialog has none.
 */
export type DialogOpening =
  | {
      trigger: ReactNode;
      open?: never;
      onOpenChange?: never;
      returnFocusTo?: never;
    }
  | {
      trigger?: never;
      open: boolean;
      onOpenChange: (open: boolean) => void;
      returnFocusTo: RefObject<HTMLElement | null>;
    };

type FormDialogProps = DialogOpening & {
  title: string;
  /** One line on what this move does. A dialog with no context is a prompt. */
  description: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  action: (
    previous: FormDialogState,
    formData: FormData,
  ) => Promise<FormDialogState>;
  /** Rendered as hidden inputs inside the form, outside the fieldset. */
  hiddenFields: Record<string, string>;
  /** The fields. Frozen while the action is in flight; gone once it succeeds. */
  children?: ReactNode;
};

/**
 * Owns nothing but "is it open" and "which run is this" (§5 guard 5).
 *
 * `useActionState` has no reset, and its value lives exactly as long as the
 * component that called it. Neither dialog unmounts when it closes — the
 * trigger stays on the page — so on the second open the hook still holds the
 * FIRST run's result: `succeeded` is true, the fieldset is gone, and the only
 * control left is the Done button that closes it again. The action becomes
 * unreachable until something remounts the whole page. The Users page
 * "Add user…" button is the live case, since it is on screen permanently and
 * adding a second user is the ordinary thing to do next.
 *
 * A fresh instance IS the reset, so the run below is keyed and the key is
 * bumped on the way IN. Bumping it on the way out — the more obvious reading
 * of "reset when the dialog closes" — resets the same state, but unmounts the
 * subtree at exactly the moment Radix needs it alive: the close animation is
 * cut, and focus return to the trigger targets a node that has already been
 * destroyed, dropping a keyboard operator at <body>. Resetting on open buys
 * the same freshness while the close path stays entirely Radix's.
 *
 * `open` stays HERE rather than inside the run, because the run is what
 * remounts: state that has to survive the reset cannot live in the thing being
 * reset.
 */
export function FormDialog(props: FormDialogProps) {
  const run = useDialogRun(props);

  return (
    <FormDialogRun
      key={run.generation}
      {...props}
      open={run.open}
      onOpenChange={run.onOpenChange}
      onCloseAutoFocus={run.onCloseAutoFocus}
    />
  );
}

/**
 * "Is it open" and "which run is this", for both action dialogs, whichever way
 * they are opened. The generation is bumped on the rising edge of `open` as
 * seen at render, because an owner-held `open` arrives as a prop rather than
 * through Radix's `onOpenChange`: watching the edge gives the menu-opened
 * dialog the same fresh run per open as the trigger-opened one.
 */
export function useDialogRun(opening: DialogOpening) {
  const [ownOpen, setOwnOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const open = opening.open ?? ownOpen;
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) setGeneration((current) => current + 1);
  }

  return {
    generation,
    open,
    onOpenChange: (next: boolean) => {
      if (opening.open === undefined) setOwnOpen(next);
      opening.onOpenChange?.(next);
    },
    onCloseAutoFocus: (event: Event) => {
      if (opening.returnFocusTo === undefined) return;
      event.preventDefault();
      opening.returnFocusTo.current?.focus();
    },
  };
}

/** One run of the action: mounted fresh per open, discarded on the next one. */
function FormDialogRun({
  trigger,
  title,
  description,
  submitLabel,
  pendingLabel,
  action,
  hiddenFields,
  children,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: Omit<FormDialogProps, "open" | "onOpenChange" | "returnFocusTo"> & {
  open: boolean;
  /** Asks the owner to open or close. Refused here while the action runs. */
  onOpenChange: (next: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [state, formAction, pending] = useActionState<
    FormDialogState,
    FormData
  >(action, null);

  const succeeded = state?.ok === true;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The one rule Radix cannot express for us: a close request arriving
        // while the action is in flight is refused outright. Radix routes
        // Escape, the overlay and the X through here, so refusing here covers
        // all three at once.
        if (pending) return;
        onOpenChange(next);
      }}
    >
      {trigger === undefined ? null : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent
        showClose={!pending}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div>{description}</div>
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="flex flex-col gap-4">
          {/* Outside the fieldset on purpose: a disabled fieldset submits none
              of its controls, and the asset id must survive the in-flight
              freeze. It is not a control the operator can touch anyway. */}
          {Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}

          {succeeded ? null : (
            // One `disabled` for every field, from the platform, rather than a
            // `disabled={pending}` threaded through each input — the version
            // that gets forgotten on the field added next year.
            <fieldset
              disabled={pending}
              className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
            >
              {children}
            </fieldset>
          )}

          {state ? (
            <p
              role="status"
              className={
                state.ok
                  ? "text-muted-foreground text-sm"
                  : "text-destructive text-sm"
              }
            >
              {state.message}
            </p>
          ) : null}

          <DialogFooter>
            {succeeded ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Done
              </Button>
            ) : (
              <>
                <Button
                  // type="button" is load-bearing: a bare <button> inside a
                  // <form> defaults to type="submit", which would turn Cancel
                  // into the very action it is cancelling.
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? pendingLabel : submitLabel}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
