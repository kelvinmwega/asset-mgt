import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function MoreMenu({
  inline,
  onRetire = () => {},
}: {
  inline: boolean;
  onRetire?: () => void;
}) {
  return (
    <div>
      <Button type="button">Assign…</Button>
      <DropdownMenu inline={inline}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline">
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label="More lifecycle actions">
          <DropdownMenuItem>Send to repair…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRetire}>Retire asset…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Radix registers a layer's outside-pointer listener on a zero-delay timer
 * after mount. A user never clicks inside that tick, so the tests must not.
 */
function settleLayers() {
  return act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("DropdownMenu", () => {
  it("puts an inline menu's items in the server markup, each label its element's only text", () => {
    const html = renderToStaticMarkup(<MoreMenu inline />);

    expect(html).toContain(">Send to repair…<");
    expect(html).toContain(">Retire asset…<");
  });

  it("keeps a portalled menu's items out of the server markup", () => {
    const html = renderToStaticMarkup(<MoreMenu inline={false} />);

    expect(html).not.toContain("Retire asset…");
  });

  it("hides an inline menu's items until it opens, and never hides the page", async () => {
    const user = userEvent.setup();
    const { container } = render(<MoreMenu inline />);
    await settleLayers();

    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(container.querySelector('[role="menu"]')).toHaveAttribute("hidden");

    await user.click(screen.getByRole("button", { name: "More" }));

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Send to repair…", "Retire asset…"]);
    expect(container).toContainElement(screen.getByRole("menu"));
    expect(screen.getByRole("button", { name: "Assign…" })).toBeVisible();
    expect(document.querySelector('[aria-hidden="true"] button')).toBeNull();
  });

  it("focuses the first item on a keyboard open, every time", async () => {
    const user = userEvent.setup();
    render(<MoreMenu inline />);
    await settleLayers();
    const more = screen.getByRole("button", { name: "More" });

    for (let round = 0; round < 2; round++) {
      more.focus();
      await settleLayers();
      await user.keyboard("{Enter}");
      await settleLayers();
      expect(
        screen.getByRole("menuitem", { name: "Send to repair…" }),
      ).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
      expect(more).toHaveFocus();
    }
  });

  it("opens on a pointer click and returns focus to the trigger on Escape, every time", async () => {
    const user = userEvent.setup();
    render(<MoreMenu inline />);
    await settleLayers();
    const more = screen.getByRole("button", { name: "More" });

    for (let round = 0; round < 2; round++) {
      await user.click(more);
      await settleLayers();
      expect(screen.getAllByRole("menuitem")).toHaveLength(2);
      await user.keyboard("{Escape}");
      await settleLayers();
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
      expect(more).toHaveFocus();
    }
  });

  it("closes on an outside click", async () => {
    const user = userEvent.setup();
    render(<MoreMenu inline />);
    await settleLayers();

    await user.click(screen.getByRole("button", { name: "More" }));
    await settleLayers();
    await user.click(document.body);

    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("runs an item's action and closes", async () => {
    const user = userEvent.setup();
    const onRetire = vi.fn();
    render(<MoreMenu inline onRetire={onRetire} />);
    await settleLayers();

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Retire asset…" }));

    expect(onRetire).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("gives every row the coarse-pointer height and keeps motion behind motion-safe (G4, G14)", async () => {
    const user = userEvent.setup();
    render(<MoreMenu inline={false} />);

    await user.click(screen.getByRole("button", { name: "More" }));

    for (const item of screen.getAllByRole("menuitem")) {
      expect(item).toHaveClass("min-h-8", "pointer-coarse:min-h-11");
    }
    const motionClasses = Array.from(screen.getByRole("menu").classList).filter(
      (name) => /transition|animate|duration|ease|starting:/.test(name),
    );
    expect(motionClasses.length).toBeGreaterThan(0);
    for (const name of motionClasses) {
      expect(name).toMatch(/^motion-safe:/);
    }
  });

  it("refuses `modal` on an inline menu at the type level", () => {
    // @ts-expect-error -- an always-mounted modal menu would aria-hide the page.
    const element = <DropdownMenu inline modal />;
    expect(element).toBeTruthy();
  });
});
