"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormSelect } from "@/components/ui/form-select";
import { FormDialog } from "@/components/form-dialog";
import { ROLE_LABELS, ROLE_ORDER } from "@/lib/labels";
import { createUser } from "./actions";

// ROLE_ORDER comes from @/lib/labels, whose only Prisma import is a TYPE — so
// no Prisma runtime reaches the client bundle, exactly as before. What changed
// is that the four roles are no longer a second, unchecked copy of the enum
// (AM-09 DESIGN §4.1). The server action re-validates regardless.

/**
 * Adding a user, one step away from the table (AM-09 DESIGN §4.4).
 *
 * It was a four-field form parked permanently below the roster, which is a page
 * you open to read far more often than to write to. The fields are unchanged;
 * they now wait to be asked for. No open signup exists — users are provisioned
 * here and nowhere else — so this button is the whole front door, which is
 * reason for it to be visible and reason for it not to be a form.
 */
export function AddUserForm() {
  return (
    <FormDialog
      action={createUser}
      hiddenFields={{}}
      trigger={<Button type="button">Add user…</Button>}
      title="Add a user"
      description="They can sign in with a magic link once this is saved. There is no self-registration — every account starts here."
      submitLabel="Add user"
      pendingLabel="Adding…"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-name">Name</Label>
        <Input id="add-name" name="name" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-email">Work email</Label>
        <Input id="add-email" name="email" type="email" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-employee-ref">Employee ref (optional)</Label>
        <Input id="add-employee-ref" name="employeeRef" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-role">Role</Label>
        <FormSelect
          id="add-role"
          name="role"
          defaultValue="STAFF_RO"
          options={ROLE_ORDER.map((role) => ({
            value: role,
            label: ROLE_LABELS[role],
          }))}
        />
      </div>
    </FormDialog>
  );
}
