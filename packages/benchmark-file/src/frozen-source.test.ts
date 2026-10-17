import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sha256 } from "./digest";
import { materializeSourceArchive, verifySourceArchive } from "./frozen-source";

it("restores captured bytes and rejects source drift before task execution", () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-frozen-")),
    live = join(root, "live.ts");
  writeFileSync(live, "captured");
  const mode = lstatSync(live).mode;
  const archivePath = join(root, "source.json");
  writeFileSync(
    archivePath,
    JSON.stringify({
      revision: "fixture",
      codeSha256: sha256(
        JSON.stringify([
          ["a.ts", mode, sha256("captured")],
          ["deleted.ts", "deleted"],
        ]),
      ),
      files: [
        { name: "a.ts", mode, base64: Buffer.from("captured").toString("base64") },
        { name: "deleted.ts", deleted: true },
      ],
    }),
  );
  writeFileSync(live, "new live contents");
  const source = join(root, "source");
  materializeSourceArchive(archivePath, source);
  expect(readFileSync(join(source, "a.ts"), "utf8")).toBe("captured");
  writeFileSync(join(source, "a.ts"), "drift");
  expect(() => verifySourceArchive(source, archivePath)).toThrow("digest mismatch");
  const bad = join(root, "bad.json");
  writeFileSync(
    bad,
    JSON.stringify({
      revision: "fixture",
      codeSha256: "a".repeat(64),
      files: [{ name: "../escape", deleted: true }],
    }),
  );
  expect(() => materializeSourceArchive(bad, join(root, "bad"))).toThrow("unsafe source path");
});
