"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { FormSelect } from "@/components/ui/form-select";
import { FormDialog, type DialogOpening } from "@/components/form-dialog";
import { conditionNotesRequiredFor } from "@/lib/asset-lifecycle";
import { assignAssetToPerson, returnAssetFromPerson } from "../actions";
import { CONDITION_LABELS, CONDITION_ORDER } from "@/lib/labels";
import { EventNoteHint } from "./event-note-hint";

/**
 * The person picker's row shape. Deliberately NOT the shape personSelectFor
 * returns: email never crosses to the client, whatever the viewer's role. The
 * picker's job is to tell two staff with the same name apart, and employeeRef —
 * the organisation's own internal number — is the field chosen for that.
 */
export type PickerPerson = {
  id: string;
  name: string;
  employeeRef: string | null;
};

/** Where a return may land. Mirrors RETURN_STATUSES, which is server-only. */
export type ReturnDestination = "IN_STOCK" | "IN_REPAIR";

/**
 * Phrased as the operator's intent rather than reusing STATUS_LABELS: this is a
 * choice between two ways of taking a laptop back, not a status picker.
 */
const DESTINATION_LABELS: Record<ReturnDestination, string> = {
  IN_STOCK: "Back to stock",
  IN_REPAIR: "Straight to repair",
};

type ConditionOption = (typeof CONDITION_ORDER)[number];

/** IN_STOCK -> ASSIGNED. Opens the assignment; the picker is over existing Person rows. */
export function AssignDialog({
  assetId,
  people,
  ...opening
}: {
  assetId: string;
  people: readonly PickerPerson[];
} & DialogOpening) {
  return (
    <FormDialog
      action={assignAssetToPerson}
      hiddenFields={{ assetId }}
      {...opening}
      title="Assign this asset"
      description="Who is taking it. The assignment records the holder — the register answers that question from here, not from a note."
      submitLabel="Assign"
      pendingLabel="Assigning…"
    >
      {people.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          There are no staff records to assign to. Staff are loaded by the seed
          script — this release has no screen for creating them (AM-03-CF-1).
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="assign-person">Assign to</Label>
            <Combobox
              id="assign-person"
              name="personId"
              options={people.map((person) => ({
                value: person.id,
                label: person.name,
                secondary: person.employeeRef,
              }))}
              placeholder="Choose a person"
              searchLabel="Search people"
              searchPlaceholder="Search by name or employee ref"
              countNoun="people"
              noMatchMessage={(query) => `No one matches "${query}".`}
              missingSecondaryLabel="No ref"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="assign-notes">Notes</Label>
            <Input id="assign-notes" name="notes" />
            {/* The form where a name is likeliest to be typed — one is being
                chosen in the field above — so it carries the same standing
                warning as every other field that writes AssetEvent.notes,
                plus the reason it is redundant here. */}
            <EventNoteHint>
              Who holds the asset is already recorded by the assignment itself.
            </EventNoteHint>
          </div>
        </>
      )}
    </FormDialog>
  );
}

/**
 * ASSIGNED -> IN_STOCK, or ASSIGNED -> IN_REPAIR.
 *
 * There is no separate "send to repair" on an assigned asset: a repair-bound
 * return IS this form with toStatus=IN_REPAIR, which keeps closing the
 * assignment and changing the status in one transaction and one event
 * (AM-03 DESIGN §4.2).
 *
 * The condition is mandatory — z.enum rejects the empty string, so there is no
 * "not recorded" option here, unlike the AM-02 forms. Whether the free-text note
 * is required depends on the SELECTED destination and condition, so it is
 * client state; conditionNotesRequiredFor is the same function the server action
 * validates with, so the marker and the guard cannot drift apart.
 *
 * `conditionNotes` is the one free-text field in this directory that does NOT
 * carry `EventNoteHint`: it is written to `Assignment.conditionNotes`, a row
 * that already names the holder, and never to `AssetEvent.notes`.
 */
export function ReturnFromPersonDialog({
  assetId,
  destinations,
  ...opening
}: {
  assetId: string;
  destinations: readonly ReturnDestination[];
} & DialogOpening) {
  // `?? "IN_STOCK"` rather than trusting destinations[0]: an empty array is
  // unreachable today (this form only renders from ASSIGNED, which permits
  // both) but indexing it is undefined at runtime and a type error the moment
  // noUncheckedIndexedAccess is turned on. Back to stock is the safe default.
  const [toStatus, setToStatus] = useState<ReturnDestination>(
    destinations[0] ?? "IN_STOCK",
  );
  const [condition, setCondition] = useState<ConditionOption>("GOOD");
  const notesRequired = conditionNotesRequiredFor(toStatus, condition);

  return (
    <FormDialog
      action={returnAssetFromPerson}
      hiddenFields={{ assetId }}
      {...opening}
      title="Take it back"
      description="Closes the assignment. Back to stock or straight to repair — one action either way, so the register is never briefly wrong about who holds it."
      submitLabel={
        toStatus === "IN_REPAIR" ? "Take back and send to repair" : "Take back"
      }
      pendingLabel="Saving…"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="return-destination">Where it goes</Label>
        <FormSelect
          id="return-destination"
          name="toStatus"
          value={toStatus}
          onValueChange={(next) => setToStatus(next as ReturnDestination)}
          options={destinations.map((destination) => ({
            value: destination,
            label: DESTINATION_LABELS[destination],
          }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="return-condition">Condition on return</Label>
        <FormSelect
          id="return-condition"
          name="condition"
          value={condition}
          onValueChange={(next) => setCondition(next as ConditionOption)}
          options={CONDITION_ORDER.map((option) => ({
            value: option,
            label: CONDITION_LABELS[option],
          }))}
          required
          placeholder="Choose a condition"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="return-condition-notes">
          Condition note{notesRequired ? " (required)" : ""}
        </Label>
        <Input
          id="return-condition-notes"
          name="conditionNotes"
          required={notesRequired}
        />
        <p className="text-muted-foreground text-xs">
          {notesRequired
            ? "Required for kit going to repair and for anything coming back poor or defective — say what is wrong with it."
            : "Optional for a routine return."}
        </p>
      </div>
    </FormDialog>
  );
}
