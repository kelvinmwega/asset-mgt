import * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const PEOPLE = [
  { value: "p1", label: "Wanjiru Kamau", secondary: "EMP-0142" },
  { value: "p2", label: "Daniel Wafula", secondary: "EMP-0087" },
  { value: "p3", label: "Edwin Waweru", secondary: null },
  { value: "p4", label: "John Otieno", secondary: "EMP-0310" },
  { value: "p5", label: "John Otieno", secondary: null },
  { value: "p6", label: "Abdi Hassan", secondary: "EMP-0011" },
] as const;

function PersonPicker(
  props: Partial<React.ComponentProps<typeof Combobox>> = {},
) {
  return (
    <Combobox
      id="person"
      name="personId"
      options={PEOPLE}
      placeholder="Choose a person"
      searchLabel="Search people"
      searchPlaceholder="Search by name or employee ref"
      countNoun="people"
      noMatchMessage={(query) => `No one matches "${query}".`}
      missingSecondaryLabel="No ref"
      required
      {...props}
    />
  );
}

function renderInForm(control: React.ReactNode = <PersonPicker />) {
  const posted: FormData[] = [];
  const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    posted.push(new FormData(event.currentTarget));
  });
  render(
    <form onSubmit={onSubmit}>
      <label htmlFor="person">Assign to</label>
      {control}
      <button type="submit">Assign</button>
    </form>,
  );
  return { posted, onSubmit };
}

function optionNames() {
  return within(screen.getByRole("listbox"))
    .queryAllByRole("option")
    .map((option) => option.textContent);
}

/** Puts the picker in its phone layout: the one query it asks is "narrow?". */
function emulateNarrowViewport() {
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
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Combobox", () => {
  it("gives the combobox role to the search field, not the trigger (G18)", async () => {
    const user = userEvent.setup();
    renderInForm();

    const trigger = screen.getByRole("button", { name: "Assign to" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await user.click(trigger);

    const search = screen.getByRole("combobox", { name: "Search people" });
    const listbox = screen.getByRole("listbox");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-controls", listbox.id);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{ArrowDown}");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getAllByRole("option")[1].id,
    );

    await user.keyboard("{ArrowUp}");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getAllByRole("option")[0].id,
    );
  });

  it("filters on a case-insensitive substring of name or employee ref and counts what is shown (G7)", async () => {
    const user = userEvent.setup();
    renderInForm();
    await user.click(screen.getByRole("button", { name: "Assign to" }));
    const search = screen.getByRole("combobox", { name: "Search people" });

    expect(screen.getByText("6 of 6 people")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    await user.type(search, "WA");
    expect(optionNames()).toEqual([
      "Wanjiru Kamau EMP-0142",
      "Daniel Wafula EMP-0087",
      "Edwin Waweru",
    ]);
    expect(screen.getByText("3 of 6 people")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "emp-03");
    expect(optionNames()).toEqual(["John Otieno EMP-0310"]);

    await user.clear(search);
    await user.type(search, "assa");
    expect(optionNames()).toEqual(["Abdi Hassan EMP-0011"]);
  });

  it("marks the matched text in place", async () => {
    const user = userEvent.setup();
    renderInForm();
    await user.click(screen.getByRole("button", { name: "Assign to" }));
    await user.type(
      screen.getByRole("combobox", { name: "Search people" }),
      "wafu",
    );

    const mark = within(
      screen.getByRole("option", { name: /Daniel Wafula/ }),
    ).getByText("Wafu");
    expect(mark.tagName).toBe("MARK");
  });

  it("says who matched nobody and offers to clear the search (G7)", async () => {
    const user = userEvent.setup();
    renderInForm();
    await user.click(screen.getByRole("button", { name: "Assign to" }));
    const search = screen.getByRole("combobox", { name: "Search people" });

    await user.type(search, "zq");

    expect(optionNames()).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent(
      'No one matches "zq".',
    );
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(optionNames()).toHaveLength(6);
  });

  it('shows "No ref" only on a ref-less row whose name repeats in the visible list (G7)', async () => {
    const user = userEvent.setup();
    renderInForm();
    await user.click(screen.getByRole("button", { name: "Assign to" }));

    const johns = screen.getAllByRole("option", { name: /John Otieno/ });
    expect(johns.map((option) => option.textContent)).toEqual([
      "John Otieno EMP-0310",
      "John Otieno No ref",
    ]);
    expect(
      screen.getByRole("option", { name: "Edwin Waweru" }),
    ).toHaveTextContent(/^Edwin Waweru$/);
    expect(screen.queryByText(/no employee ref/i)).not.toBeInTheDocument();

    await user.type(
      screen.getByRole("combobox", { name: "Search people" }),
      "joh",
    );
    expect(optionNames()).toEqual([
      "John Otieno EMP-0310",
      "John Otieno No ref",
    ]);
  });

  it("keeps ref text readable on the highlight fill (G12)", async () => {
    const user = userEvent.setup();
    renderInForm();
    await user.click(screen.getByRole("button", { name: "Assign to" }));

    const ref = within(
      screen.getByRole("option", { name: "John Otieno No ref" }),
    ).getByText("No ref");
    expect(ref).toHaveClass(
      "text-muted-foreground",
      "group-data-[selected=true]:text-accent-foreground",
    );
  });

  it("posts the chosen person under its name and shows them on the trigger (G2)", async () => {
    const user = userEvent.setup();
    const { posted } = renderInForm();

    await user.click(screen.getByRole("button", { name: "Assign to" }));
    await user.click(
      screen.getByRole("option", { name: "Daniel Wafula EMP-0087" }),
    );

    const trigger = screen.getByRole("button", { name: "Assign to" });
    expect(trigger).toHaveTextContent("Daniel Wafula EMP-0087");
    expect(trigger).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Assign" }));
    expect(posted[0].getAll("personId")).toEqual(["p2"]);
  });

  it('refuses an empty required submit with "Choose a person.", not a browser bubble (G13)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderInForm();
    const invalidEvents: Event[] = [];
    document
      .querySelector("form")!
      .addEventListener("invalid", (event) => invalidEvents.push(event), true);

    await user.click(screen.getByRole("button", { name: "Assign" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(invalidEvents.map((event) => event.defaultPrevented)).toEqual([
      true,
    ]);
    const trigger = screen.getByRole("button", { name: "Assign to" });
    expect(trigger).toHaveAttribute("data-invalid", "true");
    expect(trigger).toHaveClass("data-invalid:border-destructive");
    expect(trigger).toHaveAccessibleDescription("Choose a person.");
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: /Edwin Waweru/ }));
    expect(trigger).not.toHaveAttribute("data-invalid");
    expect(screen.queryByText("Choose a person.")).not.toBeInTheDocument();
  });

  it("gives the search field and every row the coarse-pointer height (G4)", async () => {
    const user = userEvent.setup();
    renderInForm();
    const trigger = screen.getByRole("button", { name: "Assign to" });
    expect(trigger).toHaveClass("w-full", "h-9", "pointer-coarse:h-11");

    await user.click(trigger);

    const search = screen.getByRole("combobox", { name: "Search people" });
    expect(search.parentElement).toHaveClass(
      "min-h-9",
      "pointer-coarse:min-h-11",
    );
    for (const option of screen.getAllByRole("option")) {
      expect(option).toHaveClass("min-h-8", "pointer-coarse:min-h-11");
    }
  });

  describe("below 640 px (G16)", () => {
    it("opens the search and list inline in place of the trigger, list capped to the viewport", async () => {
      emulateNarrowViewport();
      const user = userEvent.setup();
      renderInForm();
      const form = document.querySelector("form")!;

      await user.click(screen.getByRole("button", { name: "Assign to" }));

      expect(
        document.querySelector("[data-radix-popper-content-wrapper]"),
      ).toBeNull();
      const search = screen.getByRole("combobox", { name: "Search people" });
      expect(form).toContainElement(search);
      expect(search).toHaveFocus();
      expect(
        screen.queryByRole("button", { name: "Assign to" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("listbox")).toHaveClass(
        "max-h-[min(264px,40dvh)]",
      );

      await user.click(screen.getByRole("option", { name: /Abdi Hassan/ }));

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Assign to" })).toHaveFocus();
    });
  });

  describe("with the soft keyboard up (G16)", () => {
    it("caps the inline list against the visual viewport, following its resize", async () => {
      emulateNarrowViewport();
      const visualViewport = Object.assign(new EventTarget(), { height: 844 });
      vi.stubGlobal("visualViewport", visualViewport);
      const user = userEvent.setup();
      renderInForm();

      await user.click(screen.getByRole("button", { name: "Assign to" }));
      const bound = screen
        .getByRole("listbox")
        .closest<HTMLElement>('[data-slot="combobox-keyboard-bound"]')!;
      expect(bound).toHaveClass("max-h-(--picker-list-bound)");
      expect(bound.style.getPropertyValue("--picker-list-bound")).toBe(
        "337.6px",
      );

      visualViewport.height = 417;
      act(() => {
        visualViewport.dispatchEvent(new Event("resize"));
      });

      expect(bound.style.getPropertyValue("--picker-list-bound")).toBe(
        "166.8px",
      );
    });
  });

  describe("inside a Radix Dialog (G9)", () => {
    for (const layout of ["floating", "inline"] as const) {
      it(`closes the ${layout} picker on Escape without closing the dialog`, async () => {
        if (layout === "inline") emulateNarrowViewport();
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        render(
          <Dialog open onOpenChange={onOpenChange}>
            <DialogContent>
              <DialogTitle>Assign this asset</DialogTitle>
              <DialogDescription>Who is taking it.</DialogDescription>
              <label htmlFor="person">Assign to</label>
              <PersonPicker />
            </DialogContent>
          </Dialog>,
        );

        await user.click(screen.getByRole("button", { name: "Assign to" }));
        const dialog = screen.getByRole("dialog", {
          name: "Assign this asset",
        });
        expect(dialog).toContainElement(screen.getByRole("listbox"));
        expect(dialog).toContainElement(document.activeElement as HTMLElement);

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Assign to" })).toHaveFocus();
      });
    }

    it("chooses a person by click without dismissing the dialog", async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Assign this asset</DialogTitle>
            <DialogDescription>Who is taking it.</DialogDescription>
            <label htmlFor="person">Assign to</label>
            <PersonPicker />
          </DialogContent>
        </Dialog>,
      );

      await user.click(screen.getByRole("button", { name: "Assign to" }));
      await user.click(screen.getByRole("option", { name: /Edwin Waweru/ }));

      expect(onOpenChange).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Assign to" }),
      ).toHaveTextContent("Edwin Waweru");
    });
  });
});
