import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { describeActionDialogGuards } from "../../test/action-dialog-guards";

/**
 * The four AM-09 DESIGN §5 guards, asserted through the shared helper that
 * `FormDialog` also runs through — see `test/action-dialog-guards.tsx` for why
 * they live there rather than being written out once per dialog.
 *
 * This file is the harness, plus ONE local test. The guards are one property
 * held by two components, not two descriptions free to drift — but the
 * hidden-fields test below stays here rather than moving into the helper,
 * because it was written to kill a specific mutant in THIS component, found
 * when `confirm-action-dialog.tsx` was under mutation testing (issue #12;
 * since removed — docs/RUNBOOK.md) and `form-dialog.tsx` was not.
 */
describeActionDialogGuards("ConfirmActionDialog", {
  element: (action) => (
    <ConfirmActionDialog
      action={action}
      hiddenFields={{ userId: "u1" }}
      trigger={<Button type="button">Deactivate…</Button>}
      title="Deactivate someone?"
      description={<p>They lose access immediately.</p>}
      confirmLabel="Deactivate"
      pendingLabel="Deactivating…"
      destructive
    />
  ),
  trigger: "Deactivate…",
  submit: "Deactivate",
  pending: "Deactivating…",
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConfirmActionState } from "./confirm-action-dialog";

describe("the form carries its hidden fields", () => {
  it("renders the named hidden input, inside the form", async () => {
    // WHY THIS TEST EXISTS: mutation testing (issue #12) found that replacing
    // the `hiddenFields` map with `() => undefined` — rendering no hidden
    // inputs at all — killed nothing. Every §5 guard asserts that the action
    // fires, or does not; none asserted that it fires WITH ITS SUBJECT. A
    // deactivate confirmed against no userId is not a weaker dialog, it is a
    // broken one, and all four guards would still have passed.
    //
    // Selected BY NAME rather than counted. An earlier version asserted
    // `toHaveLength(1)` over every hidden input in the form, which is a
    // stricter claim than this test makes and one this component is
    // particularly likely to trip over: the form is bound to a server action
    // through `useActionState`, and React injects its own hidden fields into
    // such forms for progressive enhancement. A mock action does not, so the
    // count passed — under a real one it would fail while the property being
    // guarded still held.
    //
    // Verified rather than assumed: the map compiles to exactly ONE mutant
    // (ArrowFunction at confirm-action-dialog.tsx, `() => undefined`), and it
    // is a 1 -> 0 mutation. Nothing in the mutant set can render a SECOND
    // hidden input, so the count assertion had no mutant of its own to kill;
    // this selector kills the same mutant. If that line changes, red-prove by
    // hand: replace the hidden-field map's callback with `() => undefined`
    // and watch this test fail.
    const user = userEvent.setup();
    render(
      <ConfirmActionDialog
        action={vi.fn(async (): Promise<ConfirmActionState> => ({
          ok: true,
          message: "Done.",
        }))}
        hiddenFields={{ userId: "u1" }}
        trigger={<Button type="button">Deactivate…</Button>}
        title="Deactivate someone?"
        description={<p>They lose access immediately.</p>}
        confirmLabel="Deactivate"
        pendingLabel="Deactivating…"
        destructive
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deactivate…" }));

    const dialog = await screen.findByRole("dialog");
    const hidden = dialog.querySelector<HTMLInputElement>(
      'form input[type="hidden"][name="userId"]',
    );
    // Existence asserted separately: `toHaveValue` on a null receiver fails
    // with a type complaint rather than "the field is missing", which is the
    // failure this test is actually here to report.
    expect(hidden).toBeInTheDocument();
    expect(hidden).toHaveValue("u1");
  });
});
