import { render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AssignmentCardList } from "./assignment-card-list";

const OUT = new Date("2026-06-01T08:00:00.000Z");
const BACK = new Date("2026-07-01T17:00:00.000Z");

/**
 * This file's subject is the card list, not timezones — but `<Timestamp>`
 * renders in the viewer's zone since AM-10, so without a pin these assertions
 * read whatever zone the machine happens to be in: UTC in CI, something else on
 * every developer's laptop. Pinned to UTC so the fixtures stay legible and
 * stable; that the zone is honoured at all is asserted in timestamp.test.tsx,
 * from a non-UTC zone, which is the only place it means anything.
 */
let originalTz: string | undefined;

beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = "UTC";
});

afterAll(() => {
  process.env.TZ = originalTz;
});

const assetRow = {
  id: "a1",
  checkedOutAt: OUT,
  returnedAt: null,
  asset: {
    id: "asset-1",
    tag: "AST-0412",
    make: "Dell",
    model: "Latitude 5540",
    description: null,
    status: "ASSIGNED" as const,
  },
};

describe("AssignmentCardList — asset subject", () => {
  it("leads with the tag and the asset's status", () => {
    render(
      <AssignmentCardList subject="asset" rows={[assetRow]} label="Held" />,
    );
    expect(screen.getByRole("link", { name: "AST-0412" })).toHaveAttribute(
      "href",
      "/assets/asset-1",
    );
    expect(screen.getByTestId("status-chip")).toHaveTextContent("Assigned");
  });

  it("prints an exact checked-out date, because hover does not exist on touch", () => {
    render(
      <AssignmentCardList subject="asset" rows={[assetRow]} label="Held" />,
    );
    expect(screen.getByText(/2026-06-01 08:00 UTC/)).toBeInTheDocument();
  });

  it("says Untagged rather than going blank for a tagless asset", () => {
    render(
      <AssignmentCardList
        subject="asset"
        rows={[{ ...assetRow, asset: { ...assetRow.asset, tag: null } }]}
        label="Held"
      />,
    );
    expect(screen.getByRole("link", { name: "Untagged" })).toBeInTheDocument();
  });

  it("shows a returned date only once there is one", () => {
    const { rerender } = render(
      <AssignmentCardList subject="asset" rows={[assetRow]} label="Held" />,
    );
    // An open assignment has no "returned" fact to state, and "—" would imply
    // the field is merely empty.
    expect(screen.queryByText(/Back /)).toBeNull();

    rerender(
      <AssignmentCardList
        subject="asset"
        rows={[{ ...assetRow, returnedAt: BACK }]}
        label="Held"
      />,
    );
    expect(screen.getByText(/2026-07-01 17:00 UTC/)).toBeInTheDocument();
  });
});

describe("AssignmentCardList — person subject", () => {
  const personRow = {
    id: "a2",
    checkedOutAt: OUT,
    returnedAt: null,
    conditionNotes: null,
    person: { id: "p1", name: "Jane Mwangi", employeeRef: "EMP-0042" },
  };

  it("leads with the person and links to them", () => {
    render(
      <AssignmentCardList
        subject="person"
        rows={[personRow]}
        label="Holders"
      />,
    );
    expect(screen.getByRole("link", { name: "Jane Mwangi" })).toHaveAttribute(
      "href",
      "/people/p1",
    );
  });

  it("says Still held for an open assignment — a fact, not an empty cell", () => {
    render(
      <AssignmentCardList
        subject="person"
        rows={[personRow]}
        label="Holders"
      />,
    );
    expect(screen.getByText("Still held")).toBeInTheDocument();
  });

  it("renders a condition note when one was recorded", () => {
    render(
      <AssignmentCardList
        subject="person"
        rows={[
          { ...personRow, returnedAt: BACK, conditionNotes: "Scuffed lid" },
        ]}
        label="Holders"
      />,
    );
    expect(screen.getByText("Scuffed lid")).toBeInTheDocument();
  });

  it("is a labelled list so the card stack announces itself", () => {
    render(
      <AssignmentCardList
        subject="person"
        rows={[personRow]}
        label="Holders"
      />,
    );
    expect(
      within(screen.getByRole("list", { name: "Holders" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
  });
});
