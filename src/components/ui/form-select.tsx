"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  popupSurface,
  useDialogContainer,
  useEscapeClosesFirst,
} from "@/components/ui/popover";

/**
 * Radix `Select.Item` rejects `value=""`, so the empty choice travels inside the
 * control as this string and is mapped back to `""` before anything is posted
 * (G15). It is never exported: nothing outside this module may see it.
 */
const EMPTY_CHOICE = "__form-select-empty__";

/** The trigger look shared by every dropdown trigger: Input's box, one height. */
const triggerClasses = cn(
  "border-input dark:bg-input/30 dark:hover:bg-input/50 flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-1 text-left text-sm shadow-xs transition-[color,box-shadow] outline-none pointer-coarse:h-11 disabled:cursor-not-allowed disabled:opacity-50",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  "data-invalid:ring-destructive/20 dark:data-invalid:ring-destructive/40 data-invalid:border-destructive",
  "[&_svg]:text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0",
);

/** One option row, shared by the select panel, the picker list and the menu. */
const rowClasses =
  "relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none [overflow-wrap:anywhere] pointer-coarse:min-h-11";

/**
 * The empty-choice option labels (G5). Its "Choose a …" placeholder is never
 * an option, so it is not among them.
 */
type EmptyChoiceLabel = `Any ${string}` | "Not recorded" | "Leave unchanged";

type FormSelectOption = { value: string; label: string };

type ValueProps =
  | {
      value: string;
      onValueChange: (value: string) => void;
      defaultValue?: never;
    }
  | {
      value?: never;
      onValueChange?: (value: string) => void;
      defaultValue?: string;
    };

/**
 * The empty-choice contract as a type: an optional field offers a named empty
 * choice, a required one shows a "Choose a …" placeholder that is never an
 * option, and a field with neither always holds one of its options.
 */
type ChoiceProps =
  | { emptyLabel: EmptyChoiceLabel; required?: never; placeholder?: never }
  | { required: true; placeholder: `Choose a ${string}`; emptyLabel?: never }
  | { required?: never; placeholder?: never; emptyLabel?: never };

type FormSelectProps = {
  name: string;
  options: readonly FormSelectOption[];
  id?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
} & ValueProps &
  ChoiceProps;

/**
 * The form-side half of a custom dropdown: posts `value` under `name`, and for a
 * required field owns the app's invalid state.
 *
 * A required field renders a visually hidden text input carrying native
 * `required`, so the browser still refuses to submit the form — but its
 * `invalid` event is cancelled, which suppresses the validation bubble that
 * would otherwise point at an invisible element, and the trigger shows the
 * destructive ring and inline message instead (G13).
 */
function useFormValue({
  required,
  triggerRef,
}: {
  required: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
}) {
  const [invalid, setInvalid] = React.useState(false);

  const onInvalid = (event: React.FormEvent<HTMLInputElement>) => {
    event.preventDefault();
    setInvalid(true);
    const input = event.currentTarget;
    const firstInvalid = input.form?.querySelector(
      "input:invalid, select:invalid, textarea:invalid",
    );
    if (firstInvalid === input) triggerRef.current?.focus();
  };

  const field = (name: string, value: string, disabled?: boolean) =>
    required ? (
      <input
        aria-hidden
        tabIndex={-1}
        autoComplete="off"
        className="sr-only"
        name={name}
        value={value}
        required
        disabled={disabled}
        onChange={() => {}}
        onInvalid={onInvalid}
      />
    ) : (
      <input type="hidden" name={name} value={value} disabled={disabled} />
    );

  return { invalid, clearInvalid: () => setInvalid(false), field };
}

function FormSelect({
  name,
  options,
  id,
  className,
  disabled,
  value: controlledValue,
  onValueChange,
  defaultValue,
  emptyLabel,
  required: requiredProp,
  placeholder,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: FormSelectProps) {
  const required = requiredProp === true;
  const [ownValue, setOwnValue] = React.useState(defaultValue ?? "");
  const value = controlledValue ?? ownValue;
  const [open, setOpen] = React.useState(false);
  const { triggerRef, container, locate } =
    useDialogContainer<HTMLButtonElement>();
  const { invalid, clearInvalid, field } = useFormValue({
    required,
    triggerRef,
  });
  const messageId = React.useId();

  const close = React.useCallback(() => setOpen(false), []);
  useEscapeClosesFirst(open, close);

  const handleOpenChange = (next: boolean) => {
    if (next) locate();
    setOpen(next);
  };

  const handleValueChange = (radixValue: string) => {
    const next = radixValue === EMPTY_CHOICE ? "" : radixValue;
    if (next !== "") clearInvalid();
    if (controlledValue === undefined) setOwnValue(next);
    onValueChange?.(next);
  };

  const radixValue =
    value === "" && emptyLabel !== undefined ? EMPTY_CHOICE : value;
  const selectedLabel =
    value === ""
      ? emptyLabel
      : options.find((option) => option.value === value)?.label;
  const describedBy =
    [ariaDescribedBy, invalid ? messageId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <>
      <SelectPrimitive.Root
        value={radixValue}
        onValueChange={handleValueChange}
        open={open}
        onOpenChange={handleOpenChange}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          ref={triggerRef}
          id={id}
          data-slot="form-select-trigger"
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          className={cn(
            triggerClasses,
            "data-placeholder:text-muted-foreground [&>span]:min-w-0 [&>span]:truncate",
            className,
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder}>
            <span
              className={cn(
                "block truncate",
                value === "" && "text-muted-foreground",
              )}
            >
              {selectedLabel}
            </span>
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon asChild>
            <ChevronDown aria-hidden />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={container}>
          <SelectPrimitive.Content
            data-slot="form-select-content"
            position="popper"
            sideOffset={4}
            className={cn(
              popupSurface,
              "relative w-(--radix-select-trigger-width) max-h-[min(18rem,var(--radix-select-content-available-height))] origin-(--radix-select-content-transform-origin) overflow-hidden",
            )}
          >
            <SelectPrimitive.Viewport className="p-1">
              {emptyLabel !== undefined ? (
                <>
                  <FormSelectItem value={EMPTY_CHOICE} muted>
                    {emptyLabel}
                  </FormSelectItem>
                  <SelectPrimitive.Separator className="bg-border -mx-1 my-1 h-px" />
                </>
              ) : null}
              {options.map((option) => (
                <FormSelectItem key={option.value} value={option.value}>
                  {option.label}
                </FormSelectItem>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {field(name, value, disabled)}
      {invalid ? (
        <p id={messageId} className="text-destructive text-xs">
          {placeholder}.
        </p>
      ) : null}
    </>
  );
}

function FormSelectItem({
  value,
  muted = false,
  children,
}: {
  value: string;
  muted?: boolean;
  children: string;
}) {
  return (
    <SelectPrimitive.Item
      value={value}
      data-slot="form-select-item"
      className={cn(
        rowClasses,
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground pr-8 data-disabled:pointer-events-none data-disabled:opacity-50",
        muted && "text-muted-foreground",
      )}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

export { FormSelect, rowClasses, triggerClasses, useFormValue };
export type { EmptyChoiceLabel, FormSelectOption, FormSelectProps };
