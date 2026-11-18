"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

/**
 * The one popup surface: the select panel, the person picker and the "More"
 * menu all share it. The open transition is a CSS transition from
 * `@starting-style`, gated on `motion-safe`, because `globals.css` defines no
 * keyframes and shadcn's `animate-in` classes would do nothing (G14).
 */
const popupSurface =
  "bg-popover text-popover-foreground z-50 rounded-lg border shadow-lg outline-none motion-safe:transition-[opacity,scale] motion-safe:duration-150 motion-safe:ease-out motion-safe:starting:scale-96 motion-safe:starting:opacity-0";

/**
 * Where a popup opened from `triggerRef` must portal so it stays inside an
 * enclosing Radix Dialog's layer (G9).
 *
 * The app's Dialog is `@radix-ui/react-dialog` 1.1.23, which bundles
 * dismissable-layer 1.1.19 and focus-scope 1.1.16, while Select, Popover and
 * DropdownMenu bundle 1.2.1 and 1.3.1. The two copies keep separate layer
 * stacks, so a panel portalled to `body` is "outside" the dialog: the dialog's
 * focus trap pulls focus back out of it and a click on an option dismisses the
 * dialog. Portalling into the dialog's own content node keeps both inside.
 * Read on open, in the callback, because the trigger is not mounted at render.
 */
function useDialogContainer<T extends HTMLElement>() {
  const triggerRef = React.useRef<T>(null);
  const [container, setContainer] = React.useState<HTMLElement | undefined>();
  const locate = React.useCallback(() => {
    setContainer(
      triggerRef.current?.closest<HTMLElement>(DIALOG_SELECTOR) ?? undefined,
    );
  }, []);
  return { triggerRef, container, locate };
}

/**
 * While a popup is open, Escape closes it and nothing else (G9).
 *
 * With the layer stacks split (see `useDialogContainer`), the dialog's own
 * document-capture Escape listener is registered first and would close the
 * dialog before the popup saw the key. A window-capture listener runs ahead of
 * every document listener; marking the event handled makes both Radix layers
 * skip their dismiss, and the popup closes through its controlled state.
 */
function useEscapeClosesFirst(open: boolean, close: () => void) {
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);
}

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  container,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  container?: HTMLElement;
}) {
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          popupSurface,
          "origin-(--radix-popover-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  popupSurface,
  useDialogContainer,
  useEscapeClosesFirst,
};
