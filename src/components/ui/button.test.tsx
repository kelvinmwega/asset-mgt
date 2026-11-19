import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders an accessible button with its label", () => {
    render(<Button>Save asset</Button>);

    expect(
      screen.getByRole("button", { name: "Save asset" }),
    ).toBeInTheDocument();
  });

  it("applies the variant class pipeline (cva + cn)", () => {
    render(<Button variant="destructive">Retire</Button>);

    const button = screen.getByRole("button", { name: "Retire" });
    expect(button.className).toContain("bg-destructive");
  });

  it("renders as the child element with asChild", () => {
    // A plain <a> with an off-app href: this asserts Slot's passthrough, so it
    // deliberately avoids next/link (router context in jsdom) and avoids
    // pointing at a real page route, which @next/next/no-html-link-for-pages
    // rightly rejects in app code.
    render(
      <Button asChild>
        <a href="https://example.com/register">Open register</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Open register" });
    expect(link).toHaveAttribute("href", "https://example.com/register");
  });

  it("is at least 44px tall on a coarse pointer at every size (G4)", () => {
    render(
      <>
        <Button>Default</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Icon" />
      </>,
    );

    for (const name of ["Default", "Small", "Large"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "pointer-coarse:h-11",
      );
    }
    expect(screen.getByRole("button", { name: "Icon" })).toHaveClass(
      "pointer-coarse:size-11",
    );
  });
});
