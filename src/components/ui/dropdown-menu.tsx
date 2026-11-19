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
 * `inline` keeps the menu's items in the server-rendered markup and renders the
 * open menu in place rather than portalled. An inline menu sits in the page's
 * flow beside the actions it extends, so it is non-modal: opening it neither
 * aria-hides those actions nor swallows the next click on them. `modal` would
 * be ignored there, so the union makes it unsayable.
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

const DormantContext = React.createContext(false);

/**
 * A closed inline menu renders a static, `hidden` copy of its items, and the
 * Radix content mounts only while open. Force-mounting the content instead
 * keeps its DismissableLayer alive for the life of the page, on top of a layer
 * stack the app's Dialog does not share: its Escape handler marks every Escape
 * handled while dismissing a menu that is already closed, and the Dialog then
 * skips its own dismiss, so no Dialog on that page closes on Escape.
 */
function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 4,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof DropdownMenuPrimitive.Content>,
  "forceMount"
>) {
  const { inline, open } = React.useContext(MenuModeContext);
  const classes = cn(
    popupSurface,
    "min-w-48 origin-(--radix-dropdown-menu-content-transform-origin) p-1",
    className,
  );
  const content = (
    <DropdownMenuPrimitive.Content
      data-slot="dropdown-menu-content"
      align={align}
      sideOffset={sideOffset}
      className={classes}
      {...props}
    >
      {children}
    </DropdownMenuPrimitive.Content>
  );
  if (!inline) {
    return (
      <DropdownMenuPrimitive.Portal>{content}</DropdownMenuPrimitive.Portal>
    );
  }
  return (
    <>
      {open ? null : (
        <div
          role="menu"
          hidden
          data-slot="dropdown-menu-content"
          className={classes}
        >
          <DormantContext.Provider value>{children}</DormantContext.Provider>
        </div>
      )}
      {content}
    </>
  );
}

/** Radix's item needs the open content's context, so the dormant copy draws a plain row. */
function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  const dormant = React.useContext(DormantContext);
  const classes = cn(
    rowClasses,
    "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
    className,
  );
  if (dormant) {
    return (
      <div role="menuitem" data-slot="dropdown-menu-item" className={classes}>
        {props.children}
      </div>
    );
  }
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={classes}
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
