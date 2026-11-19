import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The server actions re-validate and write against a real database in
// actions.integration.test.ts; what is asserted here is what the role controls
// POST, so importing them would only drag Prisma and the auth stack in.
vi.mock("./actions", () => ({
  createUser: vi.fn(async () => ({ ok: true, message: "Added." })),
  changeRole: vi.fn(async () => ({ ok: true, message: "Saved." })),
  deactivateUser: vi.fn(async () => ({ ok: true, message: "Done." })),
  reactivateUser: vi.fn(async () => ({ ok: true, message: "Done." })),
}));

import { ROLE_LABELS, ROLE_ORDER } from "@/lib/labels";
import { changeRole, createUser } from "./actions";
import { AddUserForm } from "./add-user-form";
import { RoleForm, type AdminUserRow } from "./user-controls";

const admin: AdminUserRow = {
  id: "u-admin",
  name: "Wanjiru Kamau",
  email: "wanjiru@example.com",
  employeeRef: null,
  role: "ADMIN_IT",
  deactivated: false,
  lastSignInAt: null,
  lastLinkSentAt: null,
};

/**
 * Radix registers a layer's outside-pointer listener on a zero-delay timer
 * after mount. A user never clicks inside that tick, so the tests must not.
 */
function settleLayers() {
  return act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** The FormData the mocked action last received, as ordered entries. */
function posted(
  action: (state: never, formData: FormData) => unknown,
): [string, FormDataEntryValue][] {
  const formData = vi.mocked(action).mock.calls.at(-1)?.[1];
  if (!(formData instanceof FormData)) throw new Error("nothing posted");
  return Array.from(formData.entries());
}

async function chooseRole(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  label: string,
) {
  await settleLayers();
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: label }));
}

beforeEach(() => {
  vi.mocked(changeRole).mockClear();
  vi.mocked(createUser).mockClear();
});

describe("RoleForm on the shared Select", () => {
  it("posts exactly userId and role, the chosen role under the same name as before", async () => {
    const user = userEvent.setup();
    render(<RoleForm user={{ ...admin, id: "u-7" }} isSelf={false} />);
    const trigger = screen.getByRole("combobox", {
      name: "Role for wanjiru@example.com",
    });

    await chooseRole(user, trigger, "Finance");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(posted(changeRole)).toEqual([
      ["userId", "u-7"],
      ["role", "FINANCE"],
    ]);
  });

  it("offers the four roles in the shared order and shows the current one", async () => {
    const user = userEvent.setup();
    render(
      <RoleForm user={{ ...admin, role: "PROCUREMENT" }} isSelf={false} />,
    );
    const trigger = screen.getByRole("combobox", {
      name: "Role for wanjiru@example.com",
    });
    expect(trigger).toHaveTextContent("Procurement");

    await settleLayers();
    await user.click(trigger);
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(ROLE_ORDER.map((role) => ROLE_LABELS[role]));
  });

  it("still confirms a self-demotion, and the dialog posts the role chosen in the Select", async () => {
    const user = userEvent.setup();
    render(<RoleForm user={admin} isSelf />);
    const trigger = screen.getByRole("combobox", {
      name: "Role for wanjiru@example.com",
    });

    await chooseRole(user, trigger, "Procurement");
    await settleLayers();
    await user.click(screen.getByRole("button", { name: "Apply" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Remove your own admin access?",
    });
    expect(changeRole).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove my admin access" }),
    );

    expect(posted(changeRole)).toEqual([
      ["userId", "u-admin"],
      ["role", "PROCUREMENT"],
    ]);
  });

  it("asks nothing when the admin re-picks their own role, or when it is someone else", async () => {
    const user = userEvent.setup();
    render(
      <>
        <RoleForm user={admin} isSelf />
        <RoleForm
          user={{ ...admin, email: "other@example.com" }}
          isSelf={false}
        />
      </>,
    );

    const self = screen.getByRole("combobox", {
      name: "Role for wanjiru@example.com",
    });
    await chooseRole(user, self, "Finance");
    await chooseRole(user, self, "IT admin");
    await chooseRole(
      user,
      screen.getByRole("combobox", { name: "Role for other@example.com" }),
      "Finance",
    );

    for (const apply of screen.getAllByRole("button", { name: "Apply" })) {
      await user.click(apply);
    }

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changeRole).toHaveBeenCalledTimes(2);
  });

  it("server-renders one labelled trigger at full wrapper width, and no visible native select", () => {
    const html = renderToStaticMarkup(<RoleForm user={admin} isSelf={false} />);
    const container = new DOMParser().parseFromString(html, "text/html");

    expect(html.split("Role for wanjiru@example.com").length - 1).toBe(1);
    const trigger = container.querySelector<HTMLElement>(
      '[data-slot="form-select-trigger"]',
    );
    expect(trigger?.getAttribute("aria-label")).toBe(
      "Role for wanjiru@example.com",
    );
    expect(trigger?.className.split(/\s+/)).toContain("w-full");
    expect(html).not.toMatch(/\bw-fit\b/);
    for (const select of Array.from(container.querySelectorAll("select"))) {
      expect(select.getAttribute("aria-hidden")).toBe("true");
      expect(select.hasAttribute("name")).toBe(false);
    }
  });
});

describe("Add user's role on the shared Select", () => {
  async function openAndFill(user: ReturnType<typeof userEvent.setup>) {
    await settleLayers();
    await user.click(screen.getByRole("button", { name: "Add user…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a user" });
    await user.type(within(dialog).getByLabelText("Name"), "Otieno Achieng");
    await user.type(
      within(dialog).getByLabelText("Work email"),
      "otieno@example.com",
    );
    return dialog;
  }

  it("posts Staff (read-only) by default, under the same field names as before", async () => {
    const user = userEvent.setup();
    render(<AddUserForm />);
    const dialog = await openAndFill(user);

    expect(within(dialog).getByLabelText("Role")).toHaveTextContent(
      "Staff (read-only)",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add user" }));

    expect(posted(createUser)).toEqual([
      ["name", "Otieno Achieng"],
      ["email", "otieno@example.com"],
      ["employeeRef", ""],
      ["role", "STAFF_RO"],
    ]);
  });

  it("posts the chosen role, and a reopened dialog starts from the default again", async () => {
    const user = userEvent.setup();
    render(<AddUserForm />);
    const dialog = await openAndFill(user);

    await chooseRole(
      user,
      within(dialog).getByLabelText("Role"),
      "Procurement",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add user" }));
    expect(posted(createUser)).toContainEqual(["role", "PROCUREMENT"]);

    await user.keyboard("{Escape}");
    await settleLayers();
    await user.click(screen.getByRole("button", { name: "Add user…" }));
    const reopened = await screen.findByRole("dialog", { name: "Add a user" });
    expect(within(reopened).getByLabelText("Role")).toHaveTextContent(
      "Staff (read-only)",
    );
  });
});
