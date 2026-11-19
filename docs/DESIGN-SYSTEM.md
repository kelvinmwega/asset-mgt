# Design System — `asset-mgt`

Status: **proposed**, awaiting approval. Mockup:
<https://claude.ai/code/artifact/b9aa8b3c-0fa9-43de-b94b-fd660fa8d51a>

Companion to `docs/DESIGN.md` (scaffold) and the PRD stories AM-06 (PWA and
mobile flows) and AM-07 (dashboard and search), both of which assume the shell
described here already exists.

---

## 1. The ruling

**Keep shadcn/ui + Tailwind v4 + Radix.** This is not a new decision — it is
the one `docs/DESIGN.md` §20 already recorded, and it is already half-built:

| Artefact              | State                                                   |
| --------------------- | ------------------------------------------------------- |
| `components.json`     | new-york, `neutral` base, CSS variables, `lucide` icons |
| `src/app/globals.css` | full light **and** dark OKLCH token sets                |
| `src/components/ui/`  | see the component table below                           |
| `src/app/layout.tsx`  | Geist Sans + Geist Mono via `next/font`                 |
| Radix                 | slot, dialog, select, popover, dropdown-menu; plus cmdk |

The primitives in `src/components/ui/`, and what each one sits on:

| Primitive                   | Built on                        | Use it for                                   |
| --------------------------- | ------------------------------- | -------------------------------------------- |
| `button`                    | `@radix-ui/react-slot`          | every button, and `asChild` links            |
| `input`, `label`            | native elements                 | text fields and their labels                 |
| `table`, `data-card`        | native elements                 | the register's two shapes (§5)               |
| `status-chip`               | native elements                 | asset status (§6)                            |
| `dialog`                    | `@radix-ui/react-dialog`        | confirm and form dialogs                     |
| `form-select`               | `@radix-ui/react-select`        | every choose-one field that posts `FormData` |
| `combobox` (with `command`) | `@radix-ui/react-popover`, cmdk | the searchable person picker                 |
| `popover`                   | `@radix-ui/react-popover`       | the combobox panel; the shared panel surface |
| `dropdown-menu`             | `@radix-ui/react-dropdown-menu` | action menus ("More" on an asset)            |

There is no native `<select>` primitive: a JSX `select` element anywhere under
`src/` fails `pnpm lint` (`no-restricted-syntax` in `eslint.config.mjs`).

Three properties make it the right call here rather than merely the incumbent:

1. **Components are copied into the tree, not imported from a package.** The
   role-conditional rendering that enforces §`STAFF_RO`-sees-no-person-data
   lives inside the JSX (`src/app/assets/page.tsx`). A component library that
   owned that markup would put a dependency upgrade between us and a
   privacy invariant. shadcn cannot do this to us because there is nothing to
   upgrade.
2. **Tailwind v4 is CSS-first.** No `tailwind.config.ts`, so no config file
   reading env or drifting from `globals.css`. The token layer is one file.
3. **It is the studio default**, so the patterns transfer to Fleet Log and the
   car-parts monorepo rather than being learned once and thrown away.

**Rejected without much agony:** MUI and Mantine (runtime-themed, heavy, own
your markup); Chakra (same, plus a v3 API churn we would be adopting mid-flight);
plain Tailwind with no primitives (we would rebuild the Radix a11y behaviour by
hand, badly, starting with a listbox for every dropdown). None of these justify
discarding a token layer that already exists and works.

So the deliverable is **not** a library swap. It is closing four gaps.

---

## 2. Gap 1 — dark mode is dead code

`globals.css` defines `@custom-variant dark (&:is(.dark *))` and a complete
`.dark` token block. Nothing ever puts `dark` on an element.
`src/app/layout.tsx` renders a bare `<html lang="en">`, there is no
`next-themes`, and there is no toggle. Every dark value in that file is
currently unreachable.

**Decision: `next-themes`** (chosen 2026-08-01), with
`attribute="class" defaultTheme="system" enableSystem`.

```tsx
// src/app/layout.tsx
<html lang="en" suppressHydrationWarning>
  <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      {children}
    </ThemeProvider>
  </body>
</html>
```

**What this costs, stated plainly**, because both costs touch non-negotiables
in `CLAUDE.md`:

- **A client component at the root.** `ThemeProvider` is `"use client"`. It
  wraps `{children}` but does not consume them, so server components passed
  through it stay server components — the RSC payload is unaffected and pages
  keep rendering on the server. The root layout itself remains a server
  component.
- **`suppressHydrationWarning` on `<html>`.** Required, not optional:
  next-themes' inline script mutates `class` before React hydrates, and without
  the attribute every page logs a hydration mismatch. It suppresses the warning
  for that element's attributes only, one level deep — it does not mask
  mismatches in the tree below.
- **A blocking inline script.** next-themes injects one to set the class before
  first paint. It is small and synchronous; without it the app flashes light
  before switching to dark. This is a `<script>` in the document — if a CSP
  with `script-src` is ever added, it needs a nonce.
- **`force-dynamic` is unaffected.** Theme resolution is client-side and reads
  `localStorage`; it never touches the server render, so nothing here interacts
  with the env-free build requirement.

The alternative considered was a server-read `theme` cookie set by a server
action — no dependency, no client component, no flash, and a natural fit for an
app that is already dynamic SSR everywhere. It was **not** chosen: it cannot
follow the OS preference without either a client script (reintroducing the
dependency's main cost) or making every user set the theme by hand.
`defaultTheme="system"` is worth one dependency.

**Toggle placement:** the app-bar, right side, next to the user chip. Three
states — Light / Dark / System — not a two-way switch, so a user who picked
"System" can get back to it.

## 3. Gap 2 — `lucide-react` is declared but not installed

`components.json` says `"iconLibrary": "lucide"`; `package.json` has no
`lucide-react`. Every icon in the app today is either absent or would be an
inline SVG. Install it. Import named icons only (`import { Laptop } from
"lucide-react"`) so tree-shaking keeps the bundle honest.

## 4. Gap 3 — there is no app shell

This is the real reason the app reads as unfinished on desktop, and it has
nothing to do with the component library.

Today every page independently writes
`<main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 p-8">` and
its own navigation as a row of underlined links; `src/app/page.tsx` is a
centred stack of five links and a Sign out button. Navigation state, the
current user, and the role badge are re-derived per page.

**Proposed structure**

```
src/app/(app)/layout.tsx        ← shell: rail + app-bar, one requireRole
  ├── page.tsx                  ← redirect to /assets (the home page is the register)
  ├── assets/…
  ├── me/assignments/…
  ├── people/[id]/…
  └── admin/…
src/app/signin/page.tsx         ← stays outside the shell (no nav when signed out)
```

- **Left rail, 216px, persistent on `md:` and up.** Destinations: Register, My
  assignments, People, and an Admin group (Users, Categories & sites). Items are
  role-gated — `People` is hidden for `STAFF_RO`, the Admin group renders only
  for `ADMIN_IT`.
- **App bar:** global search field (a placeholder that AM-07 fills), theme
  toggle, user name + role badge, sign out.
- **Content width:** drop `max-w-5xl`. A seven-column register in a 1024px
  gutter wastes half a desktop display. Use the full width with `px-4`, or
  `max-w-[1536px]` if a hard ceiling is wanted — note Tailwind v4 dropped the
  `max-w-screen-*` utilities, so `max-w-screen-2xl` silently does nothing here.
- **One `requireRole` for the shell.** The layout needs the role to decide which
  nav items exist. This is **in addition to**, never instead of, each page's and
  each action's own `requireRole` — a layout is not an authorisation boundary,
  and the non-negotiable stands unchanged: `await requireRole(...)` remains the
  first statement of every mutating server action and route handler.

**Hiding a nav item is cosmetics, not authorisation.** The rail omits `People`
for `STAFF_RO` so the UI does not offer a door that will slam; `/people/[id]`
rejecting that role is what actually stops them.

## 5. Gap 4 — the table does not survive a phone

`src/components/ui/table.tsx` sets `whitespace-nowrap` on `TableHead` and
`TableCell`, with `overflow-x-auto` on the wrapper. That is a deliberate and
correct desktop choice — and it means a phone user side-scrolls a seven-column
grid to answer "who has AST-0412?". AM-06 asks for lookup, assign, and return
to be usable one-handed.

**Rule: one component, two shapes.** The register renders `<table>` at `md:`
and above, and a stacked card list below, from the same row data in the same
server component. Two separate screens would drift; a `useMediaQuery` would
turn a server component into a client one for no gain.

On a card, the **tag is the headline** — looking up a tag is the whole reason
someone opens this away from a desk — with the status chip on the right, then
make/model, then holder and site as secondary metadata.

**As of 2026-08-03 this covers every table in the app**, not just the register:
`/admin/users`, `/me/assignments`, `/people/[id]` and `/assets/[id]`'s
every-holder table all render a `<table>` at `md:` and a card stack below.

The rule is enforced by construction rather than by review. `ResponsiveTable`
(`src/components/ui/table.tsx`) owns the breakpoint pair — `hidden md:block` and
`md:hidden` are written once, there — and takes a **required** `cards` prop, so
a table added later with no phone shape does not typecheck. Card bodies are
built from the `DataCard*` primitives in `src/components/ui/data-card.tsx`; the
three assignment tables share one `AssignmentCardList`.

`sticky` and `containerClassName` are coupled: the table wrapper is
`overflow-x-auto`, which CSS computes to `auto` on both axes, so a sticky header
anchors to that wrapper and a wrapper with no bounded height never scrolls for
it to stick within. Pass `SCROLL_PANE` unless the caller has a tuned value (the
register does). Tables bounded by headcount or by one person's kit get neither.

Both shapes render from one query and one mapped array. The guard is a parity
assertion per page — the identifying field appears exactly twice in the markup —
which is what catches a conditional applied to the table and missed on the
cards. A test that merely asserted "a card list exists" would not.

**Navigation below `md:` is a bottom tab bar**, not a hamburger drawer. Four
destinations fit, and they stay in thumb reach; a drawer buries all four behind
a tap in the hardest corner of the screen to reach one-handed.

**Offline (AM-06)** needs a persistent indicator and disabled write
affordances. That is a slot in the shell, decided once — not a banner each
screen invents.

---

## 6. The one new token family

shadcn's `neutral` base ships **no semantic status colour**, and this register
has five statuses that operators scan all day. This is the only addition to the
token layer.

Colour weight follows **operational attention**, which is the honest mapping for
a lifecycle where the states are not peers:

| Status      | Hue                    | Why                                           |
| ----------- | ---------------------- | --------------------------------------------- |
| `IN_STOCK`  | green                  | available, healthy, no action needed          |
| `ASSIGNED`  | blue                   | the normal working state, not an alert        |
| `IN_REPAIR` | amber                  | needs a human; the one state that pulls focus |
| `ON_ORDER`  | neutral, dashed border | provisional — not here yet, tag-exempt        |
| `RETIRED`   | recessive grey         | terminal; `RETIRED` is the delete we never do |

Retired assets **recede rather than disappear**. Nothing in this codebase is
ever deleted, so the register keeps the row and drains its contrast.

Two constraints on the family:

- **Never colour alone.** Every chip carries its text label plus a dot whose
  fill differs by state (solid for stock/assigned/repair, ring-only for
  order/retired), so the five stay distinguishable without colour vision.
- **Dark values are hand-tuned, not inverted.** Lightness rises to ~0.8 and
  chroma drops, so a chip sits on `oklch(0.145 0 0)` without glowing. Exact
  values are in the mockup's `:root` block and carry over verbatim.

These are semantic tokens, separate from the accent, and are never used
decoratively.

## 7. Typography

Geist Sans and Geist Mono are already wired through `next/font` and stay.

**Mono earns its place on data, not on code.** Asset tags, serial numbers, and
event timestamps set in Geist Mono with `font-variant-numeric: tabular-nums`.
A tag is a sticker on a physical laptop — an identifier, not prose — and
tabular figures keep the column aligned as it scrolls. This is the smallest
change in the document and the most visible one in daily use.

> The mockup approximates Geist with a system grotesque stack, because the
> Artifact CSP blocks font CDNs and inlining the face would bloat the page. The
> app itself already loads the real Geist; no change needed there.

## 8. What this does not change

- No new authorisation surface. §Authorisation, §`STAFF_RO`-sees-no-person-data
  and `personSelectFor(role)` are untouched — the shell reads a role to draw a
  menu, and every page and action still checks its own.
- No change to any query. The register's role-conditional holder fetch stays
  exactly as written: for `STAFF_RO` the data is **not fetched**, and the
  missing "Held by" column is a consequence of that, never the mechanism.
- No `output: 'export'`, no static rendering, no `process.env` at module scope.
  `next-themes` is client-side and touches none of it.

## 9. Implementation order

Sized as one story (call it AM-08), **Tier 2** — it touches no auth, no PII,
and no deletion path, so the Tier 3 floor does not apply. It should land before
AM-06 and AM-07, both of which assume the shell.

1. `pnpm add next-themes lucide-react`; `ThemeProvider` +
   `suppressHydrationWarning` in the root layout; the three-state toggle.
2. `src/app/(app)/layout.tsx` — rail + app bar, role-gated nav, one
   `requireRole`. Move existing routes under it and delete their per-page
   `<main>` wrappers and ad-hoc link rows.
3. Status chip component + `--st-*` tokens in `globals.css`.
4. Responsive register: `<table>` at `md:`, card list below; mono tags with
   tabular figures.
5. Bottom tab bar below `md:`; offline indicator slot (left unwired until
   AM-06).

**Verification.** The existing integration tests
(`src/app/assets/page.integration.test.tsx`,
`src/app/me/assignments/page.integration.test.tsx`) already assert the
role-conditional register; they must stay green untouched, which is the signal
that the shell changed presentation and nothing else. Add one test that the
`STAFF_RO` register renders no holder column and no `/people/` link.

---

## 10. Open questions

- **Global search (§4, app bar).** Drawn as a placeholder here. AM-07's
  acceptance criteria include searching person names, and `CLAUDE.md` warns
  that any feature indexing `AssetEvent.notes` must exclude it from `STAFF_RO`
  reach or close that hole first. The search **field** is in scope for the
  shell; search **behaviour** is AM-07's and inherits that constraint.
- **Density.** The mockup sets a comfortable row height. If the client runs
  registers in the thousands, a compact toggle may be worth it — deferred until
  someone asks.
