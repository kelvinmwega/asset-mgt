"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The install sequence — the hero of the adopter-facing page
 * (.impeccable/surfaces/src-app-page-tsx.md, "The Install Path").
 *
 * Client only because of the copy interaction. Everything it renders is
 * present in the server HTML first: with JavaScript off the commands are still
 * readable and selectable, which is the point of a page whose whole argument
 * is "this runs".
 *
 * The slab is permanently dark in both themes. That is not a theming oversight
 * — a terminal is a dark object, and the page around it still follows the
 * viewer's preference. The colours here are page-local arbitrary values rather
 * than new tokens, deliberately: the surface brief puts the token layer out of
 * scope, and a landing page is the wrong reason to grow the design system.
 *
 * The rail is aria-hidden. It repeats the step numbers and names that the slab
 * already carries in reading order, so exposing it twice would make a screen
 * reader walk the same five steps again for no gain. Progress reaches
 * non-visual users through the live region instead.
 */

type Step = {
  id: string;
  name: string;
  lines: string[];
  caption: string;
};

const REPO = "https://github.com/kelvinmwega/asset-mgt";

const STEPS: Step[] = [
  {
    id: "clone",
    name: "Clone",
    lines: [`git clone ${REPO}`],
    caption: "Node 22 and pnpm, both versions pinned in the repo.",
  },
  {
    id: "install",
    name: "Install",
    lines: ["cd asset-mgt && pnpm install"],
    caption: "Generates the Prisma client on postinstall.",
  },
  {
    id: "configure",
    name: "Configure",
    lines: ["cp .env.example .env"],
    caption:
      "Every variable is enumerated there. Magic-link sign-in needs a Resend key.",
  },
  {
    id: "database",
    name: "Database",
    lines: ["docker compose up -d && pnpm db:migrate"],
    caption: "Postgres 17, plus the separate test database CI runs against.",
  },
  {
    id: "run",
    name: "Seed and run",
    lines: [
      "SEED_ADMIN_EMAIL=you@example.com pnpm db:seed",
      "pnpm db:seed:reference && pnpm dev",
    ],
    caption:
      "Seeds your admin, then categories and sites — an asset needs a category.",
  },
];

const ALL_COMMANDS = STEPS.flatMap((step) => step.lines).join("\n");

// Permanently-dark slab palette. Contrast against the 0.17 ground: command
// text 14.8:1, captions 6.7:1, prompt 5.2:1 — all clear of WCAG 2.2 AA, which
// PRODUCT.md records as binding.
const SLAB = "bg-[oklch(0.17_0_0)]";
const HAIRLINE = "border-[oklch(1_0_0/12%)]";
const INK = "text-[oklch(0.97_0_0)]";
const DIM = "text-[oklch(0.68_0_0)]";
const FAINT = "text-[oklch(0.62_0_0)]";

export function InstallPath() {
  const [done, setDone] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [clipboardBroken, setClipboardBroken] = useState(false);

  const copy = useCallback(
    async (label: string, text: string, ids: string[]) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Non-secure origins and denied permissions both land here. The
        // commands stay selectable, so say that rather than failing silently.
        setClipboardBroken(true);
        setAnnouncement("Clipboard unavailable. Select the commands to copy.");
        return;
      }
      setDone((prev) => [...new Set([...prev, ...ids])]);
      setAnnouncement(`${label} copied.`);
    },
    [],
  );

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-14">
      <div
        className={cn(
          "overflow-hidden rounded-xl border shadow-lg shadow-black/25",
          SLAB,
          HAIRLINE,
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2 border-b px-4 py-2.5 sm:px-6",
            HAIRLINE,
          )}
        >
          <Terminal aria-hidden="true" className={cn("size-3.5", FAINT)} />
          <span
            className={cn(
              "font-mono text-[0.7rem] tracking-[0.2em] uppercase",
              FAINT,
            )}
          >
            bash
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() =>
              copy(
                "All commands",
                ALL_COMMANDS,
                STEPS.map((s) => s.id),
              )
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[0.7rem] tracking-wide uppercase",
              "transition-colors duration-200 motion-reduce:transition-none",
              "hover:bg-[oklch(1_0_0/8%)] hover:text-[oklch(0.97_0_0)]",
              "focus-visible:ring-[3px] focus-visible:ring-[oklch(1_0_0/25%)] focus-visible:outline-none",
              DIM,
            )}
          >
            <Copy aria-hidden="true" className="size-3" />
            Copy all
          </button>
        </div>

        <ol className={cn("divide-y", "divide-[oklch(1_0_0/8%)]")}>
          {STEPS.map((step, index) => {
            const isDone = done.includes(step.id);
            return (
              <li key={step.id} className="px-4 py-5 sm:px-6">
                <div className="flex items-baseline gap-3">
                  <span
                    className={cn(
                      "font-mono text-[0.7rem] tabular-nums",
                      isDone ? INK : FAINT,
                      "transition-colors duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
                    )}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className={cn("text-[0.8125rem] font-medium", DIM)}>
                    {step.name}
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() =>
                      copy(
                        `Step ${index + 1}, ${step.name},`,
                        step.lines.join("\n"),
                        [step.id],
                      )
                    }
                    aria-label={`Copy step ${index + 1}: ${step.name}`}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[0.7rem]",
                      "transition-colors duration-200 motion-reduce:transition-none",
                      "hover:bg-[oklch(1_0_0/8%)] hover:text-[oklch(0.97_0_0)]",
                      "focus-visible:ring-[3px] focus-visible:ring-[oklch(1_0_0/25%)] focus-visible:outline-none",
                      isDone ? INK : FAINT,
                    )}
                  >
                    {isDone ? (
                      <Check aria-hidden="true" className="size-3" />
                    ) : (
                      <Copy aria-hidden="true" className="size-3" />
                    )}
                    {isDone ? "Copied" : "Copy"}
                  </button>
                </div>

                <div className="mt-2.5 space-y-1.5">
                  {step.lines.map((line) => (
                    <div key={line} className="flex gap-3">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "shrink-0 font-mono text-sm leading-relaxed select-none sm:text-base lg:text-xl",
                          FAINT,
                        )}
                      >
                        $
                      </span>
                      <code
                        className={cn(
                          "font-mono text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap sm:text-base lg:text-xl",
                          INK,
                        )}
                      >
                        {line}
                      </code>
                    </div>
                  ))}
                </div>

                <p className={cn("mt-2.5 text-xs leading-relaxed", FAINT)}>
                  {step.caption}
                </p>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Visual progress spine. Duplicates the slab's own numbering, so it is
          hidden from assistive tech; the live region below carries progress. */}
      <ol
        aria-hidden="true"
        className="hidden lg:sticky lg:top-10 lg:flex lg:h-fit lg:flex-col"
      >
        {STEPS.map((step, index) => {
          const isDone = done.includes(step.id);
          const isLast = index === STEPS.length - 1;
          return (
            <li key={step.id} className="flex gap-4">
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full border font-mono text-[0.7rem] tabular-nums",
                    "transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
                    isDone
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {isDone ? (
                    <Check className="size-3.5" />
                  ) : (
                    String(index + 1).padStart(2, "0")
                  )}
                </span>
                {!isLast ? (
                  <span
                    className={cn(
                      "my-1 w-px flex-1",
                      "transition-colors duration-300 motion-reduce:transition-none",
                      isDone ? "bg-foreground/40" : "bg-border",
                    )}
                  />
                ) : null}
              </div>
              <div className={cn("pb-7", isLast && "pb-0")}>
                <p
                  className={cn(
                    "text-sm font-medium",
                    "transition-colors duration-300 motion-reduce:transition-none",
                    isDone ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {step.name}
                </p>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  {step.caption}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {clipboardBroken ? (
        <p className="text-muted-foreground -mt-6 text-xs lg:col-span-2">
          Your browser would not let the page write to the clipboard. The
          commands above are selectable — copy them by hand.
        </p>
      ) : null}
    </div>
  );
}
