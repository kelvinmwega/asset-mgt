"use client";

import { useActionState, useState } from "react";
import type { Role } from "@prisma/client";
import { ROLE_LABELS, ROLE_ORDER } from "@/lib/labels";
import { Timestamp } from "@/components/timestamp";
import { Button } from "@/components/ui/button";
import { FormSelect } from "@/components/ui/form-select";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { changeRole, deactivateUser, reactivateUser } from "./actions";

/**
 * The per-user controls, shared by the table row and the phone card.
 *
 * Extracted so there is one definition of each. Each SHAPE mounts its own
 * instance, so a user has two `useActionState`s on the page — cheap, since
 * neither does anything until submit, and only one shape is ever in the
 * accessibility tree or the focus order because `hidden` / `md:hidden` are
 * `display:none`. jsdom applies no CSS, so tests see both and must scope by
 * testid.
 */
export type AdminUserRow = {
  id: string;
  name: string | null;
  email: string;
  employeeRef: string | null;
  role: Role;
  deactivated: boolean;
  /**
   * Last successful magic-link sign-in — `User.emailVerified`, whose semantic
   * and its Resend-is-the-only-provider precondition are spelled out at the
   * read site (page.tsx). Null is "has never signed in".
   */
  lastSignInAt: Date | null;
  /**
   * When a magic link was last ISSUED for this address, from a surviving
   * `VerificationToken` row. Null is "no unredeemed link on record" — a
   * statement about the past, NOT a live invitation. The rendered copy stays
   * past-tense fact ("Link sent 5 days ago"); never "Invite pending" or
   * "Awaiting sign-in", which would claim something this data cannot support.
   */
  lastLinkSentAt: Date | null;
};

/**
 * "Last signed in", and — when they never have — how far the invitation got.
 *
 * One column, two facts (issue #11). The question an admin brings to this
 * screen is "did the magic link work?", and "never signed in" on its own
 * cannot answer it: a person whose link was issued but never delivered looks
 * exactly like a person nobody has invited yet. The first is a broken
 * `AUTH_EMAIL_FROM`; the second is a forgotten task. Splitting these across
 * two columns would make the reader do the join.
 *
 * The phrase leads and the exact UTC value stays one hover away, never
 * replaced — the same contract as the asset history.
 */
export function SignInCell({
  lastSignInAt,
  lastLinkSentAt,
  now,
}: {
  lastSignInAt: Date | null;
  lastLinkSentAt: Date | null;
  now: Date;
}) {
  if (lastSignInAt) {
    return <Timestamp value={lastSignInAt} now={now} />;
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      {/* Not a colour. The five status hues are the asset vocabulary and mean
          nothing about a person, and this state has to survive a monochrome
          print and colour-vision deficiency alike — so the distinction is
          carried by the words and by the chip's own shape. */}
      <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
        Never signed in
      </span>
      <span className="text-muted-foreground text-xs">
        {lastLinkSentAt ? (
          <>
            Link sent <Timestamp value={lastLinkSentAt} now={now} />
          </>
        ) : (
          "No link sent yet"
        )}
      </span>
    </div>
  );
}

const ROLE_OPTIONS = ROLE_ORDER.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
}));

/**
 * The role select, its Apply button, and the action's own status message.
 *
 * The status message lives HERE rather than beside the activation control,
 * where it used to sit: it belongs to this form, and leaving it behind in the
 * Actions cell would have given the phone card a role control with no
 * save-or-error feedback at all.
 */
export function RoleForm({
  user,
  isSelf,
}: {
  user: AdminUserRow;
  isSelf: boolean;
}) {
  const [roleState, roleAction, rolePending] = useActionState(changeRole, null);
  // Controlled, so the confirm dialog can submit the chosen role. Radix renders
  // dialog content in a PORTAL at the document root, outside this row — so a
  // hidden input inside the dialog cannot reach back into the row to read the
  // select. It has to be handed the value.
  const [role, setRole] = useState<Role>(user.role);

  // Demoting yourself out of ADMIN_IT costs you this screen, so it is confirmed
  // — but only that case, and only when the chosen role is actually a demotion.
  // Every other role change is a select and a Save; wrapping those in a dialog
  // would train the operator to dismiss it.
  const selfDemotion =
    isSelf && user.role === "ADMIN_IT" && role !== "ADMIN_IT";

  return (
    <form action={roleAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="userId" value={user.id} />
      <div className="w-44">
        <FormSelect
          name="role"
          value={role}
          onValueChange={(next) => setRole(next as Role)}
          options={ROLE_OPTIONS}
          disabled={rolePending}
          aria-label={`Role for ${user.email}`}
        />
      </div>
      {selfDemotion ? (
        <SelfDemotionConfirm
          userId={user.id}
          role={role}
          pending={rolePending}
        />
      ) : (
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={rolePending}
        >
          {rolePending ? "Saving…" : "Apply"}
        </Button>
      )}
      {roleState ? (
        <span
          role="status"
          className={
            roleState.ok
              ? "text-muted-foreground text-xs"
              : "text-destructive text-xs"
          }
        >
          {roleState.message}
        </span>
      ) : null}
    </form>
  );
}

/**
 * Self-demotion out of ADMIN_IT.
 *
 * Kept as its own dialog with its own copy rather than folded into a generic
 * confirm: what makes this worth stopping for is not that a role changed, it is
 * that the person doing it is about to lose the screen they are standing on.
 * A generic "are you sure?" would say none of that.
 *
 * The server decides whether it is ALLOWED — a last remaining admin is rejected
 * by the last-admin guard. This is the warning, not the rule.
 */
function SelfDemotionConfirm({
  userId,
  role,
  pending,
}: {
  userId: string;
  role: Role;
  pending: boolean;
}) {
  return (
    <ConfirmActionDialog
      action={changeRole}
      hiddenFields={{ userId, role }}
      trigger={
        <Button type="button" variant="outline" size="sm" disabled={pending}>
          Apply
        </Button>
      }
      title="Remove your own admin access?"
      description={
        <p>
          You lose this screen immediately, and you will not be able to give the
          access back yourself. Another IT admin has to do it. If you are the
          last active one, this is refused.
        </p>
      }
      confirmLabel="Remove my admin access"
      pendingLabel="Saving…"
      destructive
    ></ConfirmActionDialog>
  );
}

/**
 * Deactivation and reactivation.
 *
 * Deactivating is confirmed for EVERYONE, not just for yourself. Before this it
 * was one unguarded click for any other user — the account, their access and
 * their sign-in link all gone on a mis-click, with no undo in the moment. That
 * gap is the reason this component exists.
 *
 * Reactivation is not confirmed: it restores access, and nothing is lost by
 * doing it accidentally.
 */
export function ActivationControl({
  user,
  isSelf,
}: {
  user: AdminUserRow;
  isSelf: boolean;
}) {
  const [state, formAction, pending] = useActionState(reactivateUser, null);

  if (user.deactivated) {
    return (
      <form action={formAction}>
        <input type="hidden" name="userId" value={user.id} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Restoring…" : "Reactivate"}
        </Button>
        {state && !state.ok ? (
          <span role="status" className="text-destructive ml-2 text-xs">
            {state.message}
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <ConfirmActionDialog
      action={deactivateUser}
      hiddenFields={{ userId: user.id }}
      trigger={
        // Not red. Red is for confirming, never for offering.
        <Button type="button" variant="outline" size="sm">
          Deactivate…
        </Button>
      }
      title={
        isSelf ? "Deactivate your own account?" : `Deactivate ${user.email}?`
      }
      description={
        isSelf ? (
          <p>
            You will be signed out at your next request and will not be able to
            sign back in. Another IT admin has to restore your access. If you
            are the last active one, this is refused.
          </p>
        ) : (
          <p>
            They lose access immediately and any sign-in link stops working. The
            person, their assignments and the audit trail all stay — this is a
            flag, not a deletion, and you can reactivate them here.
          </p>
        )
      }
      confirmLabel="Deactivate"
      pendingLabel="Deactivating…"
      destructive
    />
  );
}
