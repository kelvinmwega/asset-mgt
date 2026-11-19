"use client";

import { useActionState, type ReactNode } from "react";

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
import { useDialogRun, type DialogOpening } from "@/components/form-dialog";

/**
 * A confirmation dialog wrapped around a server action (AM-09 DESIGN §5).
 *
 * Replaces `window.confirm`, which could not carry a field, could not explain a
 * consequence in more than one sentence, and — because it is a blocking browser
 * modal — could not show the result either. The three call sites it replaces
 * are the closest things this app has to a delete.
 *
 * **What this must never become is a weaker guard than the `confirm()` it
 * replaced.** That is the specific failure LEARNINGS §Frontend records as
 * "lift-verbatim drops cross-cutting guards": the behaviour was correct in the
 * source and was never written down as an acceptance criterion, so the rewrite
 * quietly loses it. The properties being preserved, each with a test:
 *
 *  1. The action cannot fire without a second, explicit act. The trigger opens
 *     the dialog and submits nothing; only the confirm button submits.
 *  2. Dismissing NEVER submits. Escape, the overlay, the X and Cancel all close
 *     and do nothing else — `type="button"` on every one of them, because a
 *     bare <button> inside a <form> is a submit button.
 *  3. While the action is in flight the dialog cannot be dismissed at all, and
 *     the confirm button is disabled. A modal that vanishes mid-flight leaves
 *     the operator with no idea whether the thing happened.
 *  4. The result is shown, not swallowed. A rejection ("this would leave no
 *     active IT admin") is the reason the dialog exists, so it renders in
 *     place and the operator can retry or cancel.
 *
 * It deliberately does NOT close itself on success. Auto-closing would need to
 * react to a state change during render, and for an irreversible action the
 * acknowledgement is worth a click — the page behind has already revalidated,
 * so the dialog is reporting, not blocking.
 */

/**
 * The shape both `AssetActionState` and `UserActionState` already have. Stated
 * concretely rather than as a generic: every action this wraps returns exactly
 * this, and a generic here bought nothing but a variance error.
 */
export type ConfirmActionState = { ok: boolean; message: string } | null;

type ConfirmActionDialogProps = DialogOpening & {
  title: string;
  /** What will happen, and what will NOT — most of these delete nothing. */
  description: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  action: (
    previous: ConfirmActionState,
    formData: FormData,
  ) => Promise<ConfirmActionState>;
  /** Rendered as hidden inputs inside the form. */
  hiddenFields: Record<string, string>;
  /** Extra fields — a reason, a condition note. Rendered above the buttons. */
  children?: ReactNode;
};

/**
 * Owns nothing but "is it open" and "which run is this" (§5 guard 5) — the
 * same split as `FormDialog`, for the same reason and with the same shape;
 * that component's docblock is the long version.
 *
 * `useActionState` outlives a close, so without a fresh instance per open the
 * second open still shows the first run's result and offers no way to run the
 * action again. Every call site today happens to hide its own trigger once the
 * action succeeds — a deactivated user renders the Reactivate control instead,
 * a retired asset stops offering Retire — so the stale state is currently
 * unreachable here and reachable in `FormDialog`. That is a property of those
 * three call sites, not of this component, and it is not one a future caller
 * would think to check. The guard is shared, so the fix is too.
 */
export function ConfirmActionDialog(props: ConfirmActionDialogProps) {
  const run = useDialogRun(props);

  return (
    <ConfirmActionDialogRun
      key={run.generation}
      {...props}
      open={run.open}
      onOpenChange={run.onOpenChange}
      onCloseAutoFocus={run.onCloseAutoFocus}
    />
  );
}

/** One run of the action: mounted fresh per open, discarded on the next one. */
function ConfirmActionDialogRun({
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  // Stryker disable next-line BooleanLiteral: the default is dead — all three call sites pass `destructive` explicitly — and it selects a button colour variant, nothing else. A test pinning it would assert a design-token name.
  destructive = false,
  action,
  hiddenFields,
  children,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: Omit<ConfirmActionDialogProps, "open" | "onOpenChange" | "returnFocusTo"> & {
  open: boolean;
  /** Asks the owner to open or close. Refused here while the action runs. */
  onOpenChange: (next: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [state, formAction, pending] = useActionState<
    ConfirmActionState,
    FormData
  >(action, null);

  const succeeded = state?.ok === true;

  return (
    /*
     * MUTATION-TESTING NOTE (issue #12). Guard 3 — "an in-flight action cannot
     * be dismissed" — is implemented FOUR times over: once in `onOpenChange`,
     * and once in each of the three Radix escape hatches below.
     *
     * For ESCAPE that is a genuine redundancy: `onEscapeKeyDown` and
     * `onOpenChange` each stop it on their own, so a mutant removing either one
     * survives no matter how good the test is. Those two are ignored below, and
     * the behaviour itself IS proven — see "refuses Escape and keeps the dialog
     * open while pending".
     *
     * For the OVERLAY it is not redundancy, it is an untested route:
     * `onPointerDownOutside` and `onInteractOutside` are deliberately NOT
     * ignored, and Stryker reports them as no-coverage, because nothing
     * exercises overlay dismissal at all. jsdom cannot: Radix sets
     * `pointer-events: none` on <body>, so userEvent refuses the click
     * (LEARNINGS §Testing — pointer/layout behaviour belongs in a real-browser
     * smoke). Leaving them red keeps that gap on the report instead of burying
     * it in an ignore list.
     *
     * All four are kept rather than thinned because `showClose={!pending}` is
     * the only thing currently keeping the X button away from `onOpenChange`,
     * and that is a rendering decision one prop-change away from being wrong.
     */
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The one rule Radix cannot express for us: a close request arriving
        // while the action is in flight is refused outright. Radix routes
        // Escape, the overlay and the X through here, so refusing here covers
        // all three at once.
        // Stryker disable next-line ConditionalExpression: redundant with onEscapeKeyDown for the only route a test can drive — see the note above.
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
        /* Stryker disable BlockStatement,ConditionalExpression: redundant with the onOpenChange refusal above; no test can attribute the proven Escape behaviour to one layer or the other. */
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        /* Stryker restore BlockStatement,ConditionalExpression */
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
          {Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}

          {succeeded ? null : children}

          {state ? (
            <p
              role="status"
              /* Stryker disable StringLiteral: Tailwind colour class names. No test asserts on this paragraph's classes, and one able to kill these would go red on any design-token rename while catching no behaviour change. What matters here — the result is announced, in place, via role="status" — is guard 4 and is tested. */
              className={
                state.ok
                  ? "text-muted-foreground text-sm"
                  : "text-destructive text-sm"
              }
              /* Stryker restore StringLiteral */
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
                <Button
                  type="submit"
                  /* Stryker disable next-line StringLiteral: button colour
                     variant names, same reason as the status paragraph above. */
                  variant={destructive ? "destructive" : "default"}
                  disabled={pending}
                >
                  {pending ? pendingLabel : confirmLabel}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
