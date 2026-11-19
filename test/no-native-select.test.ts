// @vitest-environment node
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "no-restricted-syntax";

const eslint = new ESLint({ cwd: process.cwd() });

/**
 * Lints source as if it lived at `filePath`, so the rule's `files` glob is
 * exercised at the depths and extensions a real call site would have
 * (tooling/eslint-flat-config-globs). Returns the native-select hits only.
 */
async function nativeSelectHits(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === RULE);
}

const NATIVE = `export function F() {\n  return <select name="x" />;\n}\n`;

describe("custom-dropdowns G1: no native <select> under src/", () => {
  it.each([
    "src/x.tsx",
    "src/components/ui/select.tsx",
    "src/app/(app)/assets/[id]/deeper/still/deeper/form.tsx",
    "src/app/(app)/admin/users/form.jsx",
  ])("refuses a JSX <select> at %s", async (filePath) => {
    const hits = await nativeSelectHits(NATIVE, filePath);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 2, severity: 2 });
    expect(hits[0].message).toContain("FormSelect");
  });

  it("leaves the shared primitives alone while still refusing the native one", async () => {
    const code = [
      "export function F() {",
      "  return (",
      "    <>",
      '      <FormSelect name="a" />',
      '      <Select name="b" />',
      '      <select name="c" />',
      "    </>",
      "  );",
      "}",
      "",
    ].join("\n");
    const hits = await nativeSelectHits(
      code,
      "src/app/(app)/assets/asset-form.tsx",
    );
    expect(hits.map((h) => h.line)).toEqual([6]);
  });
});
