import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The server actions are the whole point of `../actions`, and importing it here
// would drag Prisma and the auth stack into a component test. What each button
// DOES is asserted against a real database in actions.integration.test.ts; what
// is asserted here is which button exists and what it asks for.
vi.mock("../actions", () => ({
  receiveAndTagAsset: vi.fn(async () => ({ ok: true, message: "Received." })),
  retireAsset: vi.fn(async () => ({ ok: true, message: "Retired." })),
  returnFromRepair: vi.fn(async () => ({ ok: true, message: "Returned." })),
  sendToRepair: vi.fn(async () => ({ ok: true, message: "Sent." })),
  assignAssetToPerson: vi.fn(async () => ({ ok: true, message: "Assigned." })),
  returnAssetFromPerson: vi.fn(async () => ({ ok: true, message: "Back." })),
}));

import { CONDITION_LABELS, CONDITION_ORDER } from "@/lib/labels";
import {
  assignAssetToPerson,
  receiveAndTagAsset,
  returnAssetFromPerson,
  sendToRepair,
} from "../actions";
import { LifecycleActions, type LifecycleMove } from "./lifecycle-actions";
import type { PickerPerson, ReturnDestination } from "./assignment-actions";

/**
 * #10: the lifecycle forms moved into dialogs behind a primary button and a
 * `More` menu, so every affordance a status offers is now a trigger rather than
 * an expanded form heading.
 *
 * The AM-03 acceptance claim — WHICH moves each status offers, and that ASSIGNED
 * offers no separate "send to repair" — is asserted where it always was, against
 * the real transition map and the real page, in `assignment-ui.integration.test.tsx`.
 * What that file can no longer see is anything INSIDE a dialog: Radix portals it
 * and mounts it only once open, so it is absent from server-rendered markup. The
 * half of the claim that lives inside the return dialog (both destinations, one
 * action) and inside the assign dialog (the picker disambiguates by employeeRef)
 * is asserted here instead, by opening them.
 */

const people: PickerPerson[] = [
  { id: "p1", name: "Asha Mwangi", employeeRef: "EMP-0042" },
  { id: "p2", name: "Asha Mwangi", employeeRef: "EMP-0117" },
  { id: "p3", name: "Asha Mwangi", employeeRef: null },
  { id: "p4", name: "Brian Otieno", employeeRef: null },
];
const BOTH_DESTINATIONS: ReturnDestination[] = ["IN_STOCK", "IN_REPAIR"];

/** The moves the page derives for each status (see `lifecycleMovesFor`). */
const MOVES: Record<string, LifecycleMove[]> = {
  ON_ORDER: ["RECEIVE", "RETIRE"],
  IN_STOCK: ["ASSIGN", "SEND_TO_REPAIR", "RETIRE"],
  ASSIGNED: ["RETURN_FROM_PERSON", "RETIRE"],
  IN_REPAIR: ["RETURN", "RETIRE"],
  RETIRED: [],
};

function renderMoves(moves: LifecycleMove[]) {
  render(
    <LifecycleActions
      assetId="a1"
      moves={moves}
      people={people}
      returnDestinations={BOTH_DESTINATIONS}
    />,
  );
  return userEvent.setup();
}

/**
 * Radix registers a layer's outside-pointer listener on a zero-delay timer
 * after mount. A user never clicks inside that tick, so the tests must not.
 */
function settleLayers() {
  return act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** Opens `More`, when the status offers one, so the moves behind it are on screen. */
async function openMore(user: ReturnType<typeof userEvent.setup>) {
  await settleLayers();
  const more = screen.queryByRole("button", { name: "More" });
  if (more) await user.click(more);
}

/** Whether an affordance sits in the `More` menu rather than leading. Call with the menu open. */
function behindMore(name: string): boolean {
  const affordance =
    screen.queryByRole("button", { name }) ??
    screen.getByRole("menuitem", { name });
  return affordance.closest('[role="menu"]') !== null;
}

/** Whether a move is offered at all, leading or in the open menu. */
function offered(name: string): boolean {
  return (
    screen.queryByRole("button", { name }) !== null ||
    screen.queryByRole("menuitem", { name }) !== null
  );
}

async function openDialog(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const lead = screen.queryByRole("button", { name });
  if (lead) {
    await user.click(lead);
  } else {
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name }));
  }
  return screen.findByRole("dialog");
}

/** The FormData the mocked action last received. */
function posted(
  action: (state: never, formData: FormData) => unknown,
): FormData {
  const formData = vi.mocked(action).mock.calls.at(-1)?.[1];
  if (!(formData instanceof FormData)) throw new Error("nothing posted");
  return formData;
}

/** Every option's accessible name in the open list. */
function optionNames() {
  return screen.getAllByRole("option").map((option) => option.textContent);
}

describe("one primary action per status, the rest behind More", () => {
  it("leads with Receive and tag on an ON_ORDER asset", async () => {
    const user = renderMoves(MOVES.ON_ORDER!);
    await openMore(user);

    expect(behindMore("Receive and tag…")).toBe(false);
    expect(behindMore("Retire asset…")).toBe(true);
    expect(offered("Assign…")).toBe(false);
  });

  it("leads with Assign on an IN_STOCK asset, and offers send to repair and retire", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);
    await openMore(user);

    expect(behindMore("Assign…")).toBe(false);
    expect(behindMore("Send to repair…")).toBe(true);
    expect(behindMore("Retire asset…")).toBe(true);
    // Nothing is out with anyone, so there is nothing to take back.
    expect(offered("Take it back…")).toBe(false);
  });

  it("leads with Take it back on an ASSIGNED asset, and offers no second path out", async () => {
    const user = renderMoves(MOVES.ASSIGNED!);
    await openMore(user);

    expect(behindMore("Take it back…")).toBe(false);
    expect(behindMore("Retire asset…")).toBe(true);
    // AM-03 §4.2: a repair-bound return IS the return action. A parallel
    // "send to repair" here would close the assignment in a second event.
    expect(offered("Send to repair…")).toBe(false);
    expect(offered("Assign…")).toBe(false);
  });

  it("leads with Return from repair on an IN_REPAIR asset", async () => {
    const user = renderMoves(MOVES.IN_REPAIR!);
    await openMore(user);

    expect(behindMore("Return from repair…")).toBe(false);
    expect(behindMore("Retire asset…")).toBe(true);
  });

  it("offers nothing at all on a RETIRED asset", () => {
    renderMoves(MOVES.RETIRED!);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/lifecycle ends here/i)).toBeInTheDocument();
  });

  it("lists every move behind More in the server markup, each label its element's only text", () => {
    const html = renderToStaticMarkup(
      <LifecycleActions
        assetId="a1"
        moves={MOVES.IN_STOCK!}
        people={people}
        returnDestinations={BOTH_DESTINATIONS}
      />,
    );

    expect(html).toContain(">Send to repair…<");
    expect(html).toContain(">Retire asset…<");
  });

  it("keeps Retire last, behind a separator", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);
    await openMore(user);

    const menu = screen.getByRole("menu", { name: "More" });
    expect(
      Array.from(menu.children).map(
        (child) => child.getAttribute("role") + ":" + child.textContent,
      ),
    ).toEqual([
      "menuitem:Send to repair…",
      "separator:",
      "menuitem:Retire asset…",
    ]);
  });
});

/**
 * G10. The menu's content unmounts as it closes, which is exactly when the
 * chosen move's dialog opens, so these fail if the dialog is nested in it.
 */
describe("a move chosen from More", () => {
  it("closes the menu, opens its dialog, and returns focus to More when the dialog closes", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);

    const dialog = await openDialog(user, "Send to repair…");

    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(dialog).toHaveAccessibleName("Send to repair");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "More" })).toHaveFocus();
  });

  it("closes on Escape and on an outside click, focus back on More", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);
    const more = screen.getByRole("button", { name: "More" });

    await openMore(user);
    await settleLayers();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(more).toHaveFocus();

    await openMore(user);
    await settleLayers();
    await user.click(document.body);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("opens a fresh run each time, not the last one's result", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);

    let dialog = await openDialog(user, "Send to repair…");
    await user.click(
      within(dialog).getByRole("button", { name: "Send to repair" }),
    );
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Sent.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "More" })).toHaveFocus();

    dialog = await openDialog(user, "Send to repair…");
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Send to repair" }),
    ).toBeEnabled();
  });
});

describe("what the dialogs ask for", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers both destinations on one Take it back form, condition mandatory with no Not recorded", async () => {
    const user = renderMoves(MOVES.ASSIGNED!);

    const dialog = await openDialog(user, "Take it back…");

    // Both ways out of ASSIGNED, on one form and one action.
    const destination = within(dialog).getByLabelText("Where it goes");
    expect(destination).toHaveTextContent("Back to stock");
    await user.click(destination);
    expect(optionNames()).toEqual(["Back to stock", "Straight to repair"]);
    await user.keyboard("{Escape}");

    // Condition is the structured answer to "in what state" and is mandatory:
    // there is deliberately no "not recorded" option (AM-03 AC-2).
    const condition = within(dialog).getByLabelText("Condition on return");
    expect(condition).toBeRequired();
    expect(condition).toHaveTextContent("Good");
    await user.click(condition);
    expect(optionNames()).toEqual(
      CONDITION_ORDER.map((value) => CONDITION_LABELS[value]),
    );
    await user.keyboard("{Escape}");
  });

  it("posts the destination and condition under their old names, the note required for repair (G2)", async () => {
    const user = renderMoves(MOVES.ASSIGNED!);

    let dialog = await openDialog(user, "Take it back…");
    await user.click(within(dialog).getByRole("button", { name: "Take back" }));
    expect(posted(returnAssetFromPerson).getAll("toStatus")).toEqual([
      "IN_STOCK",
    ]);
    expect(posted(returnAssetFromPerson).getAll("condition")).toEqual(["GOOD"]);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));

    dialog = await openDialog(user, "Take it back…");
    await user.click(within(dialog).getByLabelText("Where it goes"));
    await user.click(
      screen.getByRole("option", { name: "Straight to repair" }),
    );
    await user.click(within(dialog).getByLabelText("Condition on return"));
    await user.click(screen.getByRole("option", { name: "Poor" }));
    expect(
      within(dialog).getByLabelText("Condition note (required)"),
    ).toBeRequired();
    await user.type(
      within(dialog).getByLabelText("Condition note (required)"),
      "Hinge cracked",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Take back and send to repair",
      }),
    );

    expect(posted(returnAssetFromPerson).getAll("toStatus")).toEqual([
      "IN_REPAIR",
    ]);
    expect(posted(returnAssetFromPerson).getAll("condition")).toEqual(["POOR"]);
  });

  it("tells same-named people apart in the picker, and carries no email (G7, G8)", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);

    const dialog = await openDialog(user, "Assign…");
    await user.click(within(dialog).getByRole("button", { name: "Assign to" }));

    // Three people named Asha Mwangi. The employee ref is the organisation's
    // own internal number and what tells them apart; the one without a ref is
    // marked rather than left identical. An email would work too, and is
    // deliberately never sent to the client.
    expect(within(dialog).getByRole("listbox")).toBeInTheDocument();
    const names = optionNames();
    expect(names).toEqual([
      "Asha Mwangi EMP-0042",
      "Asha Mwangi EMP-0117",
      "Asha Mwangi No ref",
      "Brian Otieno",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(dialog.textContent).not.toMatch(/@|no employee ref/i);

    await user.type(
      screen.getByRole("combobox", { name: "Search people" }),
      "0117",
    );
    expect(optionNames()).toEqual(["Asha Mwangi EMP-0117"]);

    await user.clear(screen.getByRole("combobox", { name: "Search people" }));
    await user.type(
      screen.getByRole("combobox", { name: "Search people" }),
      "zq",
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      'No one matches "zq".',
    );
  });

  it('refuses Assign with nobody chosen, "Choose a person.", then posts the person chosen (G2, G13)', async () => {
    const user = renderMoves(MOVES.IN_STOCK!);

    const dialog = await openDialog(user, "Assign…");
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));

    expect(assignAssetToPerson).not.toHaveBeenCalled();
    const trigger = within(dialog).getByRole("button", { name: "Assign to" });
    expect(trigger).toHaveAccessibleDescription("Choose a person.");
    expect(trigger).toHaveAttribute("data-invalid", "true");

    await user.click(trigger);
    await user.click(
      screen.getByRole("option", { name: "Asha Mwangi EMP-0117" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));

    expect(posted(assignAssetToPerson).getAll("personId")).toEqual(["p2"]);
  });

  it("opens the picker empty again after an assignment (action-state-dialog-reset)", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);

    let dialog = await openDialog(user, "Assign…");
    await user.click(within(dialog).getByRole("button", { name: "Assign to" }));
    await user.click(screen.getByRole("option", { name: "Brian Otieno" }));
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));
    await user.click(
      await within(dialog).findByRole("button", { name: "Done" }),
    );

    dialog = await openDialog(user, "Assign…");
    expect(
      within(dialog).getByRole("button", { name: "Assign to" }),
    ).toHaveTextContent("Choose a person");
  });

  it("closes the open picker on Escape and leaves the dialog open (G9)", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);
    const dialog = await openDialog(user, "Assign…");
    const trigger = within(dialog).getByRole("button", { name: "Assign to" });

    await user.click(trigger);
    expect(dialog).toContainElement(screen.getByRole("listbox"));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(trigger).toHaveFocus();
  });

  describe("below 640 px (G16)", () => {
    beforeEach(() => {
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
          }) as MediaQueryList,
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("opens the search and list inline in the dialog's form, above Cancel and Assign", async () => {
      const user = renderMoves(MOVES.IN_STOCK!);
      const dialog = await openDialog(user, "Assign…");

      await user.click(
        within(dialog).getByRole("button", { name: "Assign to" }),
      );

      expect(
        dialog.querySelector("[data-radix-popper-content-wrapper]"),
      ).toBeNull();
      const form = dialog.querySelector("form")!;
      const listbox = within(form).getByRole("listbox");
      expect(listbox).toHaveClass("max-h-[min(264px,40dvh)]");
      expect(
        listbox.compareDocumentPosition(
          within(form).getByRole("button", { name: "Assign" }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        within(form).getByRole("combobox", { name: "Search people" }),
      ).toHaveFocus();
    });
  });
});

/**
 * G2, G5, G15: each condition posts under `condition` exactly as the native
 * select did, and the empty choice arrives as "" so the action writes NULL.
 */
describe("the condition a lifecycle dialog posts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function optionsOf(
    user: ReturnType<typeof userEvent.setup>,
    trigger: HTMLElement,
  ) {
    await user.click(trigger);
    const names = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    await user.keyboard("{Escape}");
    return names;
  }

  it("offers Not recorded on receipt, and posts it as an empty string", async () => {
    const user = renderMoves(MOVES.ON_ORDER!);
    const dialog = await openDialog(user, "Receive and tag…");
    const condition = within(dialog).getByLabelText("Condition on arrival");

    expect(await optionsOf(user, condition)).toEqual([
      "Not recorded",
      ...CONDITION_ORDER.map((value) => CONDITION_LABELS[value]),
    ]);
    await user.type(within(dialog).getByLabelText("Asset tag"), "IT-0001");
    await user.click(condition);
    await user.click(screen.getByRole("option", { name: "Not recorded" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Receive and tag" }),
    );

    expect(posted(receiveAndTagAsset).getAll("condition")).toEqual([""]);
  });

  it("offers Leave unchanged on repair, posting the default until it is chosen", async () => {
    const user = renderMoves(MOVES.IN_STOCK!);
    let dialog = await openDialog(user, "Send to repair…");
    const condition = within(dialog).getByLabelText("Condition");

    expect(condition).toHaveTextContent("Defective");
    expect((await optionsOf(user, condition))[0]).toBe("Leave unchanged");
    await user.click(
      within(dialog).getByRole("button", { name: "Send to repair" }),
    );
    expect(posted(sendToRepair).getAll("condition")).toEqual(["DEFECTIVE"]);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));

    dialog = await openDialog(user, "Send to repair…");
    await user.click(within(dialog).getByLabelText("Condition"));
    await user.click(screen.getByRole("option", { name: "Leave unchanged" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Send to repair" }),
    );
    expect(posted(sendToRepair).getAll("condition")).toEqual([""]);
  });

  it("closes the open condition list on Escape and leaves the dialog open (G9)", async () => {
    const user = renderMoves(MOVES.IN_REPAIR!);
    const dialog = await openDialog(user, "Return from repair…");
    const condition = within(dialog).getByLabelText("Condition");

    await user.click(condition);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(condition).toHaveFocus();
  });
});

/**
 * THE assertion this file exists for.
 *
 * `AssetEvent.notes` is operator-typed free text rendered to all four roles
 * including STAFF_RO, who are otherwise shown no person data at all, and the
 * table is never updated and never deleted. `EventNoteHint` is the only
 * mitigation on that channel (CLAUDE.md, §"No personal data in event tables").
 *
 * Moving five forms into dialogs is exactly the change that loses it silently:
 * the field goes, the hint stays behind, and every other test still passes. So
 * each dialog is opened and the hint is looked for BESIDE its input — not
 * anywhere in the dialog, which would still pass with the two pulled apart.
 */
describe("EventNoteHint travels with every field that writes AssetEvent.notes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["Receive and tag…", "Notes", MOVES.ON_ORDER!],
    ["Assign…", "Notes", MOVES.IN_STOCK!],
    ["Send to repair…", "Notes", MOVES.IN_STOCK!],
    ["Return from repair…", "Notes", MOVES.IN_REPAIR!],
    ["Retire asset…", "Reason", MOVES.ASSIGNED!],
  ])("warns beside the %s field", async (trigger, label, moves) => {
    const user = renderMoves(moves);

    const dialog = await openDialog(user, trigger);

    const field = within(dialog).getByLabelText(label);
    expect(field.closest("div")).toHaveTextContent(/never personal data/i);
  });
});
