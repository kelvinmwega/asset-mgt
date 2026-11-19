"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Hand-written shadcn-style dialog primitives (scaffold pattern — the shadcn
 * CLI has a CSS validation bug under Tailwind v4, LEARNINGS §Next.js).
 *
 * Radix supplies the parts that are genuinely hard and that a hand-rolled modal
 * always gets wrong: focus trapping, focus RETURN to the trigger on close,
 * `aria-modal` and the labelling wiring, inert background content, and Escape.
 * What it does not decide is whether a close is allowed at all — see
 * `ConfirmActionDialog`, where a close mid-flight has to be refused.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

function subscribeVisibleViewport(onChange: () => void) {
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", onChange);
  viewport?.addEventListener("scroll", onChange);
  return () => {
    viewport?.removeEventListener("resize", onChange);
    viewport?.removeEventListener("scroll", onChange);
  };
}

/**
 * The visible part of the page, as CSS variables for `DialogContent` (G16).
 *
 * A fixed dialog is laid out against the layout viewport, which iOS Safari and
 * Chrome's default `resizes-visual` mode leave at full height with the soft
 * keyboard up, so `top-1/2` and a `dvh` cap both put the footer under the
 * keyboard. The keyboard shrinks and scrolls the visual viewport instead.
 * Read through `useSyncExternalStore` so the server and the first client
 * render agree on "unknown", where the CSS falls back to the layout viewport.
 */
function useVisibleViewportVars(): React.CSSProperties | undefined {
  const top = React.useSyncExternalStore(
    subscribeVisibleViewport,
    () => window.visualViewport?.offsetTop ?? null,
    () => null,
  );
  const height = React.useSyncExternalStore(
    subscribeVisibleViewport,
    () => window.visualViewport?.height ?? null,
    () => null,
  );
  if (top === null || height === null) return undefined;
  return {
    "--dialog-visible-top": `${top}px`,
    "--dialog-visible-height": `${height}px`,
  } as React.CSSProperties;
}

/**
 * Centred on, and no taller than, the visible viewport; the body scrolls
 * inside it while `DialogFooter` stays pinned at its foot (G16).
 *
 * The scroll lives on an inner body, never on the content node itself: Select
 * and Popover panels portal INTO the content node (`useDialogContainer`, G9),
 * and the content node's transform makes it their fixed-position containing
 * block, so an overflow on it would clip every floating panel at its edge.
 */
function DialogContent({
  className,
  children,
  showClose = true,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Hidden while an action is in flight — there is nothing safe to close to. */
  showClose?: boolean;
}) {
  const visibleViewportVars = useVisibleViewportVars();
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-background fixed top-[calc(var(--dialog-visible-top,0px)+var(--dialog-visible-height,100dvh)/2)] left-1/2 z-50 flex max-h-[calc(var(--dialog-visible-height,100dvh)-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border shadow-lg duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        style={{ ...visibleViewportVars, ...style }}
        {...props}
      >
        <div
          data-slot="dialog-body"
          className="grid min-h-0 gap-4 overflow-y-auto overscroll-contain rounded-[inherit] p-5"
        >
          {children}
        </div>
        {showClose ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus-visible:ring-ring absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  );
}

/**
 * Pinned to the foot of the scrolling dialog body, so the actions stay on
 * screen however far the fields scroll (G16). The negative margins bleed its
 * background over the body's padding and the matching padding puts the
 * buttons back where they sit at rest. The inset is `-bottom-5`, not
 * `bottom-0`, because Chromium measures a sticky inset from the scroller's
 * padding-deflated box: at `bottom-0` the footer rose by the body's padding
 * at rest and covered the last field. Below 640 px the hairline is the
 * mockup's sticky-actions rule (`mockups/combobox.html`).
 */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "bg-background sticky -bottom-5 -mx-5 -mt-2 -mb-5 flex flex-wrap justify-end gap-2 px-5 pt-2 pb-5 max-sm:border-t",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
