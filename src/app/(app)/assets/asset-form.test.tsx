import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("./actions", () => ({
  createAsset: vi.fn(async () => ({ ok: false, message: "Not saved." })),
  updateAsset: vi.fn(async () => ({ ok: false, message: "Not saved." })),
}));

import { createAsset, updateAsset } from "./actions";
import { AssetForm, type AssetFormValues } from "./asset-form";

const categories = [
  { id: "cat-laptop", name: "Laptops" },
  { id: "cat-phone", name: "Phones" },
];
const sites = [
  { id: "site-nbo", name: "Nairobi HQ" },
  { id: "site-msa", name: "Mombasa depot" },
];

/** Every field the create action reads, each posted exactly once. */
const CREATE_FIELDS = [
  "categoryId",
  "condition",
  "costCentre",
  "department",
  "description",
  "location",
  "make",
  "model",
  "poNumber",
  "purchasePrice",
  "purchasedAt",
  "serial",
  "siteId",
  "status",
  "supplier",
  "tag",
  "warrantyUntil",
];

const asset: AssetFormValues = {
  id: "asset-1",
  tag: "IT-0001",
  categoryId: "cat-phone",
  make: "Apple",
  model: "iPhone 15",
  description: "",
  serial: "",
  purchasedAt: "",
  purchasePrice: "",
  supplier: "",
  warrantyUntil: "",
  condition: "",
  siteId: "",
  poNumber: "",
  costCentre: "",
  department: "",
  location: "",
};

type User = ReturnType<typeof userEvent.setup>;

async function optionsOf(user: User, label: string) {
  await user.click(screen.getByLabelText(label));
  const names = within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((option) => option.textContent);
  await user.keyboard("{Escape}");
  return names;
}

async function choose(user: User, label: string, option: string) {
  await user.click(screen.getByLabelText(label));
  await user.click(screen.getByRole("option", { name: option }));
}

/** The FormData the form action received on its last call. */
async function postedTo(action: unknown): Promise<FormData> {
  const mock = action as Mock;
  await waitFor(() => expect(mock).toHaveBeenCalled());
  return mock.mock.lastCall![1] as FormData;
}

beforeEach(() => {
  vi.mocked(createAsset).mockClear();
  vi.mocked(updateAsset).mockClear();
});

describe("AssetForm on create", () => {
  it("starts Category empty and offers only the categories, never the placeholder (G5, G6)", async () => {
    render(<AssetForm categories={categories} sites={sites} />);
    const user = userEvent.setup();

    expect(screen.getByLabelText("Category")).toHaveTextContent(
      "Choose a category",
    );
    expect(await optionsOf(user, "Category")).toEqual(["Laptops", "Phones"]);
  });

  it("refuses to submit with no category, showing the app's invalid state instead of a browser bubble (G6, G13)", async () => {
    render(<AssetForm categories={categories} sites={sites} />);
    const user = userEvent.setup();
    const invalidEvents: Event[] = [];
    document
      .querySelector("form")!
      .addEventListener("invalid", (event) => invalidEvents.push(event), true);

    await user.type(screen.getByLabelText("Make"), "Dell");
    await user.type(screen.getByLabelText("Model"), "Latitude 7450");
    await user.click(screen.getByRole("button", { name: "Add asset" }));

    expect(createAsset).not.toHaveBeenCalled();
    expect(invalidEvents.length).toBeGreaterThan(0);
    expect(invalidEvents.every((event) => event.defaultPrevented)).toBe(true);
    const category = screen.getByLabelText("Category");
    expect(category).toHaveAttribute("aria-invalid", "true");
    expect(category).toHaveAccessibleDescription("Choose a category.");

    await choose(user, "Category", "Laptops");
    await user.click(screen.getByRole("button", { name: "Add asset" }));

    expect((await postedTo(createAsset)).getAll("categoryId")).toEqual([
      "cat-laptop",
    ]);
  });

  it("posts every field once under today's names, the empty choices as empty strings (G2, G15)", async () => {
    render(<AssetForm categories={categories} sites={sites} />);
    const user = userEvent.setup();

    await choose(user, "Category", "Phones");
    await user.type(screen.getByLabelText("Make"), "Apple");
    await user.type(screen.getByLabelText("Model"), "iPhone 15");
    await user.click(screen.getByRole("button", { name: "Add asset" }));

    const posted = await postedTo(createAsset);
    expect([...posted.keys()].sort()).toEqual(CREATE_FIELDS);
    expect(posted.get("status")).toBe("ON_ORDER");
    expect(posted.get("categoryId")).toBe("cat-phone");
    expect(posted.get("condition")).toBe("");
    expect(posted.get("siteId")).toBe("");
  });

  it("posts the chosen status, condition and site, and the empty choice again once re-chosen (G2, G15)", async () => {
    render(<AssetForm categories={categories} sites={sites} />);
    const user = userEvent.setup();

    await choose(
      user,
      "Starting status",
      "In stock (already on the shelf — needs a tag)",
    );
    await choose(user, "Category", "Laptops");
    await choose(user, "Condition", "Good");
    await choose(user, "Site", "Mombasa depot");
    await choose(user, "Condition", "Not recorded");
    await user.type(screen.getByLabelText("Asset tag"), "IT-0420");
    await user.type(screen.getByLabelText("Make"), "Dell");
    await user.type(screen.getByLabelText("Model"), "Latitude 7450");
    await user.click(screen.getByRole("button", { name: "Add asset" }));

    const posted = await postedTo(createAsset);
    expect(posted.getAll("status")).toEqual(["IN_STOCK"]);
    expect(posted.getAll("condition")).toEqual([""]);
    expect(posted.getAll("siteId")).toEqual(["site-msa"]);
  });

  it('offers "Not recorded" first for Condition and Site, never "Unassigned" (G5)', async () => {
    render(<AssetForm categories={categories} sites={sites} />);
    const user = userEvent.setup();

    expect(screen.getByLabelText("Site")).toHaveTextContent("Not recorded");
    expect(await optionsOf(user, "Site")).toEqual([
      "Not recorded",
      "Nairobi HQ",
      "Mombasa depot",
    ]);
    expect(screen.getByLabelText("Condition")).toHaveTextContent(
      "Not recorded",
    );
    expect((await optionsOf(user, "Condition"))[0]).toBe("Not recorded");
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
  });
});

describe("AssetForm on edit", () => {
  it("opens on the asset's own category, condition and site, and posts them (G6)", async () => {
    render(
      <AssetForm
        categories={categories}
        sites={sites}
        asset={{ ...asset, condition: "GOOD", siteId: "site-nbo" }}
      />,
    );
    const user = userEvent.setup();

    expect(screen.queryByLabelText("Starting status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Category")).toHaveTextContent("Phones");
    expect(screen.getByLabelText("Condition")).toHaveTextContent("Good");
    expect(screen.getByLabelText("Site")).toHaveTextContent("Nairobi HQ");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const posted = await postedTo(updateAsset);
    expect(posted.getAll("assetId")).toEqual(["asset-1"]);
    expect(posted.getAll("categoryId")).toEqual(["cat-phone"]);
    expect(posted.getAll("condition")).toEqual(["GOOD"]);
    expect(posted.getAll("siteId")).toEqual(["site-nbo"]);
  });

  it("clears a recorded site back to an empty string, never the internal stand-in (G15)", async () => {
    render(
      <AssetForm
        categories={categories}
        sites={sites}
        asset={{ ...asset, siteId: "site-nbo" }}
      />,
    );
    const user = userEvent.setup();

    await choose(user, "Site", "Not recorded");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const posted = await postedTo(updateAsset);
    expect(posted.getAll("siteId")).toEqual([""]);
    expect(posted.getAll("condition")).toEqual([""]);
  });
});
