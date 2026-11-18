"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

import { cn } from "@/lib/utils";
import { rowClasses } from "@/components/ui/form-select";
import { popupSurface } from "@/components/ui/popover";

type MenuMode = { inline: boolean; open: boolean };

const MenuModeContext = React.createContext<MenuMode>({
  inline: false,
  open: false,
});

type DropdownMenuProps = Omit<
  React.ComponentProps<typeof DropdownMenuPrimitive.Root>,
  "open" | "defaultOpen" | "modal"
> &
  ({ inline: true; modal?: never } | { inline?: false; modal?: boolean });

/**
 * `inline` keeps the menu's items in the server-rendered markup: the content is
 * always mounted (closed, it carries the `hidden` attribute), rendered in place
 * rather than portalled, and the menu is non-modal — Radix's modal menu calls
 * `hideOthers` on mount, which on an always-mounted menu would hide the whole
 * page from assistive tech for good. The union makes `modal` unsayable there.
 */
function DropdownMenu({
  inline = false,
  modal,
  onOpenChange,
  ...props
}: DropdownMenuProps) {
  const [open, setOpen] = React.useState(false);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <MenuModeContext.Provider value={{ inline, open }}>
      <DropdownMenuPrimitive.Root
        open={open}
        onOpenChange={handleOpenChange}
        modal={inline ? false : modal}
        {...props}
      />
    </MenuModeContext.Provider>
  );
}

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

/**
 * An inline menu is remounted on each open (the `key`), because Radix focuses
 * the first item from its focus scope's mount — an always-mounted scope never
 * mounts again, so a keyboard open would leave focus on the trigger.
 *
 * The closed instance refuses its close-autofocus: its unmount on open would
 * otherwise put focus back on the trigger, and the menu just opened would read
 * that as focus outside and dismiss itself (seen in Chromium on every open).
 */
function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 4,
  onCloseAutoFocus,
  ...props
}: Omit<
  React.ComponentProps<typeof DropdownMenuPrimitive.Content>,
  "forceMount"
>) {
  const { inline, open } = React.useContext(MenuModeContext);
  const dormant = inline && !open;
  const content = (
    <DropdownMenuPrimitive.Content
      key={inline ? String(open) : undefined}
      data-slot="dropdown-menu-content"
      align={align}
      sideOffset={sideOffset}
      forceMount={inline ? true : undefined}
      hidden={dormant}
      onCloseAutoFocus={(event) => {
        if (dormant) event.preventDefault();
        else onCloseAutoFocus?.(event);
      }}
      className={cn(
        popupSurface,
        "min-w-48 origin-(--radix-dropdown-menu-content-transform-origin) p-1",
        className,
      )}
      {...props}
    />
  );
  return inline ? (
    content
  ) : (
    <DropdownMenuPrimitive.Portal>{content}</DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        rowClasses,
        "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
export type { DropdownMenuProps };
