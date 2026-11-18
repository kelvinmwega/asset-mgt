import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormSelect } from "@/components/ui/form-select";
import { Input } from "@/components/ui/input";

const CONDITIONS = [
  { value: "NEW", label: "New" },
  { value: "GOOD", label: "Good" },
  { value: "DEFECTIVE", label: "Defective" },
] as const;

const CATEGORIES = [
  { value: "cat-laptop", label: "Laptops" },
  { value: "cat-phone", label: "Phones" },
] as const;

/** Submits through a real button, the way the forms do, and records what was posted. */
function renderInForm(control: React.ReactNode) {
  const posted: FormData[] = [];
  const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    posted.push(new FormData(event.currentTarget));
  });
  render(
    <form onSubmit={onSubmit}>
      <label htmlFor="field">Field</label>
      {control}
      <button type="submit">Save</button>
    </form>,
  );
  return { posted, onSubmit };
}

describe("FormSelect", () => {
  it("posts the empty choice as an empty string, never as its internal stand-in (G15)", async () => {
    const user = userEvent.setup();
    const { posted } = renderInForm(
      <FormSelect
        id="field"
        name="condition"
        emptyLabel="Not recorded"
        options={CONDITIONS}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(posted[0].getAll("condition")).toEqual([""]);

    await user.click(screen.getByLabelText("Field"));
    await user.click(screen.getByRole("option", { name: "Good" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(posted[1].getAll("condition")).toEqual(["GOOD"]);

    await user.click(screen.getByLabelText("Field"));
    await user.click(screen.getByRole("option", { name: "Not recorded" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(posted[2].getAll("condition")).toEqual([""]);
    expect(screen.getByLabelText("Field")).toHaveTextContent("Not recorded");
  });

  it("lists the empty choice first, then the options, with the placeholder never offered", async () => {
    const user = userEvent.setup();
    render(
      <>
        <label htmlFor="cond">Condition</label>
        <FormSelect
          id="cond"
          name="condition"
          emptyLabel="Leave unchanged"
          defaultValue="GOOD"
          options={CONDITIONS}
        />
        <label htmlFor="cat">Category</label>
        <FormSelect
          id="cat"
          name="categoryId"
          required
          placeholder="Choose a category"
          options={CATEGORIES}
        />
      </>,
    );

    await user.click(screen.getByLabelText("Condition"));
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Leave unchanged", "New", "Good", "Defective"]);
    expect(screen.getByRole("option", { name: "Good" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{Escape}");

    expect(screen.getByLabelText("Category")).toHaveTextContent(
      "Choose a category",
    );
    await user.click(screen.getByLabelText("Category"));
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Laptops", "Phones"]);
  });

  it("refuses an empty required submit with the app's invalid state, not a browser bubble (G13)", async () => {
    const user = userEvent.setup();
    const { posted, onSubmit } = renderInForm(
      <FormSelect
        id="field"
        name="categoryId"
        required
        placeholder="Choose a category"
        options={CATEGORIES}
      />,
    );
    const invalidEvents: Event[] = [];
    document
      .querySelector("form")!
      .addEventListener("invalid", (event) => invalidEvents.push(event), true);

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(invalidEvents).toHaveLength(1);
    expect(invalidEvents[0].defaultPrevented).toBe(true);
    const trigger = screen.getByLabelText("Field");
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(trigger).toHaveAttribute("aria-required", "true");
    expect(trigger).not.toHaveAttribute("required");
    expect(trigger).toHaveAccessibleDescription("Choose a category.");
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Phones" }));
    expect(trigger).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Choose a category.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(posted[0].getAll("categoryId")).toEqual(["cat-phone"]);
  });

  it("opens below its trigger as a popper panel, not item-aligned over it (G17)", async () => {
    const user = userEvent.setup();
    renderInForm(
      <FormSelect
        id="field"
        name="condition"
        emptyLabel="Not recorded"
        options={CONDITIONS}
      />,
    );

    await user.click(screen.getByLabelText("Field"));

    const listbox = screen.getByRole("listbox");
    expect(
      listbox.closest("[data-radix-popper-content-wrapper]"),
    ).not.toBeNull();
    expect(listbox).toHaveAttribute("data-side", "bottom");
  });

  it("fills its wrapper and shares the one control height with Input (G3, G4)", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Input aria-label="Tag" />
        <label htmlFor="field">Field</label>
        <FormSelect
          id="field"
          name="condition"
          emptyLabel="Not recorded"
          options={CONDITIONS}
        />
      </>,
    );

    const trigger = screen.getByLabelText("Field");
    expect(trigger).toHaveClass("[&>span]:min-w-0", "[&>span]:truncate");
    for (const control of [trigger, screen.getByLabelText("Tag")]) {
      expect(control).toHaveClass("w-full", "h-9", "pointer-coarse:h-11");
      expect(control.className).not.toMatch(/\bw-fit\b/);
    }

    await user.click(trigger);
    for (const option of screen.getAllByRole("option")) {
      expect(option).toHaveClass("min-h-8", "pointer-coarse:min-h-11");
    }
  });

  it("keeps secondary text readable on the highlight fill (G12)", async () => {
    const user = userEvent.setup();
    renderInForm(
      <FormSelect
        id="field"
        name="condition"
        emptyLabel="Not recorded"
        options={CONDITIONS}
      />,
    );

    await user.click(screen.getByLabelText("Field"));

    const empty = screen.getByRole("option", { name: "Not recorded" });
    expect(empty).toHaveClass(
      "text-muted-foreground",
      "data-highlighted:bg-accent",
      "data-highlighted:text-accent-foreground",
    );
  });

  it("animates only under motion-safe, so reduced motion opens with no fade or scale (G14)", async () => {
    const user = userEvent.setup();
    renderInForm(
      <FormSelect
        id="field"
        name="condition"
        emptyLabel="Not recorded"
        options={CONDITIONS}
      />,
    );

    await user.click(screen.getByLabelText("Field"));

    const motionClasses = Array.from(
      screen.getByRole("listbox").classList,
    ).filter((name) => /transition|animate|duration|ease|starting:/.test(name));
    expect(motionClasses.length).toBeGreaterThan(0);
    for (const name of motionClasses) {
      expect(name).toMatch(/^motion-safe:/);
    }
  });

  it("works controlled, reporting the empty choice as an empty string", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    function Controlled() {
      const [value, setValue] = React.useState("GOOD");
      return (
        <>
          <label htmlFor="field">Field</label>
          <FormSelect
            id="field"
            name="condition"
            emptyLabel="Not recorded"
            options={CONDITIONS}
            value={value}
            onValueChange={(next) => {
              onValueChange(next);
              setValue(next);
            }}
          />
          <output>{`value=${value}`}</output>
        </>
      );
    }
    render(<Controlled />);

    await user.click(screen.getByLabelText("Field"));
    await user.click(screen.getByRole("option", { name: "Not recorded" }));

    expect(onValueChange).toHaveBeenLastCalledWith("");
    expect(screen.getByText("value=")).toBeInTheDocument();
  });

  it("server-renders the chosen label and the posted value", () => {
    const html = renderToStaticMarkup(
      <form>
        <FormSelect
          id="field"
          name="condition"
          emptyLabel="Not recorded"
          defaultValue="DEFECTIVE"
          options={CONDITIONS}
          aria-label="Condition"
        />
      </form>,
    );

    expect(html).toContain(">Defective<");
    expect(html).toContain('name="condition" value="DEFECTIVE"');
    expect(html.split('aria-label="Condition"').length - 1).toBe(1);
  });

  it("makes the empty-choice contract a type error (G5)", () => {
    const shapes = [
      // @ts-expect-error -- a required field needs its "Choose a …" placeholder.
      <FormSelect key="a" name="a" options={CATEGORIES} required />,
      // @ts-expect-error -- "All" is not one of the four empty-choice phrases.
      <FormSelect key="b" name="b" options={CATEGORIES} emptyLabel="All" />,
      <FormSelect
        key="c"
        name="c"
        options={CATEGORIES}
        required
        placeholder="Choose a category"
        // @ts-expect-error -- a required field offers no empty choice.
        emptyLabel="Not recorded"
      />,
      // @ts-expect-error -- a placeholder belongs only to a required field.
      <FormSelect
        key="d"
        name="d"
        options={CATEGORIES}
        placeholder="Choose a site"
      />,
    ];
    expect(shapes).toHaveLength(4);
  });

  describe("inside a Radix Dialog (G9)", () => {
    function renderInDialog() {
      const onOpenChange = vi.fn();
      render(
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Receive delivery</DialogTitle>
            <DialogDescription>Record what arrived.</DialogDescription>
            <label htmlFor="field">Condition</label>
            <FormSelect
              id="field"
              name="condition"
              emptyLabel="Not recorded"
              options={CONDITIONS}
            />
          </DialogContent>
        </Dialog>,
      );
      return { onOpenChange };
    }

    it("renders the panel inside the dialog's layer and keeps focus there", async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderInDialog();

      await user.click(screen.getByLabelText("Condition"));

      const dialog = screen.getByRole("dialog");
      const listbox = screen.getByRole("listbox");
      expect(dialog).toContainElement(listbox);
      expect(dialog).toContainElement(document.activeElement as HTMLElement);

      await user.click(screen.getByRole("option", { name: "Defective" }));
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Condition")).toHaveTextContent("Defective");
    });

    it("closes the panel on Escape without closing the dialog", async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderInDialog();

      await user.click(screen.getByLabelText("Condition"));
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      await user.keyboard("{Escape}");

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Condition")).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
