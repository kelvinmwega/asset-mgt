import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A soft keyboard shrinks the visual viewport and may scroll it, while the
 * layout viewport a fixed dialog is positioned against stays put (G16).
 */
function stubVisualViewport(offsetTop: number, height: number) {
  const viewport = Object.assign(new EventTarget(), { offsetTop, height });
  vi.stubGlobal("visualViewport", viewport);
  return viewport;
}

function renderDialog() {
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Assign this asset</DialogTitle>
        <DialogDescription>Who is taking it.</DialogDescription>
        <DialogFooter>
          <button type="button">Cancel</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
  return screen.getByRole("dialog", { name: "Assign this asset" });
}

describe("DialogContent and the visual viewport (G16)", () => {
  it("is centred on and capped to the visual viewport, not the layout viewport", () => {
    stubVisualViewport(0, 844);
    const dialog = renderDialog();

    expect(dialog).toHaveClass(
      "top-[calc(var(--dialog-visible-top,0px)+var(--dialog-visible-height,100dvh)/2)]",
      "max-h-[calc(var(--dialog-visible-height,100dvh)-2rem)]",
    );
    expect(dialog.style.getPropertyValue("--dialog-visible-top")).toBe("0px");
    expect(dialog.style.getPropertyValue("--dialog-visible-height")).toBe(
      "844px",
    );
  });

  it("follows a visual-viewport resize, as the keyboard opens", () => {
    const viewport = stubVisualViewport(0, 844);
    const dialog = renderDialog();

    viewport.height = 417;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(dialog.style.getPropertyValue("--dialog-visible-height")).toBe(
      "417px",
    );
  });

  it("follows a visual-viewport scroll, as the page pans to the focused field", () => {
    const viewport = stubVisualViewport(0, 417);
    const dialog = renderDialog();

    viewport.offsetTop = 180;
    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });

    expect(dialog.style.getPropertyValue("--dialog-visible-top")).toBe("180px");
  });

  it("falls back to the layout viewport where the API is missing", () => {
    vi.stubGlobal("visualViewport", undefined);
    const dialog = renderDialog();

    expect(dialog.style.getPropertyValue("--dialog-visible-height")).toBe("");
  });

  it("scrolls an inner body, never the content node that panels portal into (G9)", () => {
    stubVisualViewport(0, 417);
    const dialog = renderDialog();
    const body = dialog.querySelector<HTMLElement>('[data-slot="dialog-body"]');

    expect(body).toHaveClass("overflow-y-auto", "min-h-0");
    expect(dialog).not.toHaveClass("overflow-y-auto");
    expect(dialog).not.toHaveClass("overflow-hidden");
  });

  /**
   * The content's `top` and `max-height` are bound to the visual viewport, so
   * any transition duration on it slides the dialog on every keyboard resize,
   * reduced motion included (G14). jsdom computes no transitions; the
   * real-engine `getAnimations()` check is in the story's delivery record.
   */
  it("never transitions its geometry as the visual viewport moves (G14)", () => {
    stubVisualViewport(0, 844);
    const dialog = renderDialog();

    expect(dialog).toHaveClass("transition-none");
  });

  it("pins the footer to the foot of the scrolling body", () => {
    stubVisualViewport(0, 417);
    renderDialog();
    const footer = screen
      .getByRole("button", { name: "Cancel" })
      .closest('[data-slot="dialog-footer"]');

    expect(footer).toHaveClass("sticky", "-bottom-5", "bg-background");
  });
});
