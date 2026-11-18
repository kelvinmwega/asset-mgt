"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { triggerClasses, useFormValue } from "@/components/ui/form-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  useDialogContainer,
  useEscapeClosesFirst,
} from "@/components/ui/popover";

type ComboboxOption = {
  value: string;
  label: string;
  secondary: string | null;
};

type ComboboxProps = {
  id: string;
  name: string;
  options: readonly ComboboxOption[];
  placeholder: `Choose a ${string}`;
  searchLabel: string;
  searchPlaceholder: string;
  countNoun: string;
  noMatchMessage: (query: string) => string;
  missingSecondaryLabel: string;
  required?: boolean;
  disabled?: boolean;
  defaultValue?: string;
  "aria-describedby"?: string;
};

const NARROW_QUERY = "(max-width: 639.98px)";

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Below 640 px the picker opens inline in the dialog body instead of floating
 * (G16). Read through `useSyncExternalStore` rather than a measure-in-effect
 * hook feeding a `useState` initialiser, which would lock in the server's
 * answer (frontend-react/usestate-initialiser-ssr-sentinel). The server says
 * "not narrow"; the picker is closed during SSR, so nothing renders from it.
 */
function useIsNarrow() {
  return React.useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/** Case-insensitive substring on any of the texts — never a prefix or fuzzy score (G7). */
function matchesQuery(texts: readonly string[], query: string) {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" || texts.some((text) => text.toLowerCase().includes(needle))
  );
}

function searchTexts(option: ComboboxOption) {
  return option.secondary ? [option.label, option.secondary] : [option.label];
}

function commandFilter(_value: string, search: string, keywords?: string[]) {
  return matchesQuery(keywords ?? [], search) ? 1 : 0;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const needle = query.trim().toLowerCase();
  const at = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-inherit underline underline-offset-2">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/**
 * A searchable picker over a list the page already holds. cmdk owns filtering
 * and the listbox semantics; this owns the trigger, the posted value, the
 * invalid state, the live count and the inline phone layout.
 *
 * The trigger is a plain button, on which ARIA 1.2 supports neither
 * `aria-invalid` nor `aria-required`: the invalid state is the destructive ring
 * (`data-invalid`) plus the message the trigger is described by.
 */
function Combobox({
  id,
  name,
  options,
  placeholder,
  searchLabel,
  searchPlaceholder,
  countNoun,
  noMatchMessage,
  missingSecondaryLabel,
  required = false,
  disabled,
  defaultValue,
  "aria-describedby": ariaDescribedBy,
}: ComboboxProps) {
  const [value, setValue] = React.useState(defaultValue ?? "");
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const narrow = useIsNarrow();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const restoreFocus = React.useRef(false);
  const { triggerRef, container, locate } =
    useDialogContainer<HTMLButtonElement>();
  const { invalid, clearInvalid, field } = useFormValue({
    required,
    triggerRef,
  });
  const messageId = React.useId();

  const changeOpen = React.useCallback(
    (next: boolean) => {
      if (next) locate();
      else setQuery("");
      setOpen(next);
    },
    [locate],
  );
  const close = React.useCallback(() => {
    restoreFocus.current = true;
    changeOpen(false);
  }, [changeOpen]);
  useEscapeClosesFirst(open, close);

  React.useEffect(() => {
    if (open && narrow) inputRef.current?.focus();
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open, narrow, triggerRef]);

  const choose = (next: string) => {
    setValue(next);
    clearInvalid();
    close();
  };

  const clearSearch = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  const visible = options.filter((option) =>
    matchesQuery(searchTexts(option), query),
  );
  const labelCounts = new Map<string, number>();
  for (const option of visible) {
    labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
  }
  const selected = options.find((option) => option.value === value);
  const describedBy =
    [ariaDescribedBy, invalid ? messageId : null].filter(Boolean).join(" ") ||
    undefined;
  const inline = narrow;

  const picker = (
    <Command
      label={searchLabel}
      filter={commandFilter}
      defaultValue={value || undefined}
      className={cn(inline && "bg-transparent")}
    >
      <CommandInput
        ref={inputRef}
        value={query}
        onValueChange={setQuery}
        placeholder={searchPlaceholder}
        wrapperClassName={cn(
          inline &&
            "border-ring ring-ring/50 rounded-md border ring-[3px] dark:bg-input/30",
        )}
      />
      <CommandList
        className={cn(
          inline && "mt-1.5 max-h-[min(264px,40dvh)] rounded-lg border",
        )}
      >
        {options.map((option) => {
          const secondary =
            option.secondary ??
            ((labelCounts.get(option.label) ?? 0) > 1
              ? missingSecondaryLabel
              : null);
          return (
            <CommandItem
              key={option.value}
              value={option.value}
              keywords={searchTexts(option)}
              onSelect={() => choose(option.value)}
            >
              <span className="min-w-0 flex-1 truncate">
                {highlightMatch(option.label, query)}
              </span>
              {secondary ? (
                <>
                  {" "}
                  <span className="text-muted-foreground group-data-[selected=true]:text-accent-foreground font-mono text-xs whitespace-nowrap">
                    {option.secondary
                      ? highlightMatch(option.secondary, query)
                      : secondary}
                  </span>
                </>
              ) : null}
              {option.value === value ? (
                <Check className="size-4 shrink-0" aria-hidden />
              ) : null}
            </CommandItem>
          );
        })}
      </CommandList>
      <CommandEmpty>
        <div
          role="status"
          className="text-muted-foreground flex flex-col items-center gap-2 px-3 py-4 text-center text-sm"
        >
          {noMatchMessage(query.trim())}
          <Button type="button" variant="ghost" size="sm" onClick={clearSearch}>
            Clear search
          </Button>
        </div>
      </CommandEmpty>
      <div
        aria-live="polite"
        className={cn(
          "text-muted-foreground px-3 py-1.5 text-xs empty:hidden",
          inline ? "px-0.5" : "border-t",
        )}
      >
        {visible.length > 0
          ? `${visible.length} of ${options.length} ${countNoun}`
          : null}
      </div>
    </Command>
  );

  const trigger = (
    <button
      ref={triggerRef}
      id={id}
      type="button"
      data-slot="combobox-trigger"
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-describedby={describedBy}
      data-invalid={invalid || undefined}
      className={triggerClasses}
      onClick={inline ? () => changeOpen(true) : undefined}
    >
      {selected ? (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{selected.label}</span>
          {selected.secondary ? (
            <>
              {" "}
              <span className="text-muted-foreground font-mono text-xs">
                {selected.secondary}
              </span>
            </>
          ) : null}
        </span>
      ) : (
        <span className="text-muted-foreground truncate">{placeholder}</span>
      )}
      <ChevronsUpDown aria-hidden />
    </button>
  );

  return (
    <>
      {inline ? (
        open ? (
          <div data-slot="combobox-inline">{picker}</div>
        ) : (
          trigger
        )
      ) : (
        <Popover open={open} onOpenChange={changeOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            container={container}
            className="w-(--radix-popover-trigger-width) p-0"
          >
            {picker}
          </PopoverContent>
        </Popover>
      )}
      {field(name, value, disabled)}
      {invalid ? (
        <p id={messageId} className="text-destructive text-xs">
          {placeholder}.
        </p>
      ) : null}
    </>
  );
}

export { Combobox };
export type { ComboboxOption, ComboboxProps };
