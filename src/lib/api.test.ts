import { describe, it, expect } from "vitest";
import { isDiskConflict } from "./api";

// Cross-language contract with `write_file` in `src-tauri/src/fs.rs`. The literal
// below is a copy of `fs::CONFLICT_MSG`; the Rust side carries the mirror assert.
// If either moves without the other, the editor's Overwrite / Reload recovery
// silently becomes unreachable and a conflicted save just fails.
describe("write_file conflict contract", () => {
  const RUST_CONFLICT_MSG = "The file changed on disk since you opened it.";

  it("recognises the Rust conflict error as recoverable", () => {
    expect(isDiskConflict(RUST_CONFLICT_MSG)).toBe(true);
    // Tauri rejects with the bare string, but FileEditor strips an "Error: "
    // prefix first — both shapes must be recognised.
    expect(isDiskConflict(`Error: ${RUST_CONFLICT_MSG}`)).toBe(true);
  });

  it("does not offer Overwrite/Reload for unrecoverable write failures", () => {
    expect(
      isDiskConflict("Refusing to write through a symlink (the file points elsewhere).")
    ).toBe(false);
    expect(isDiskConflict("Permission denied (os error 13)")).toBe(false);
    expect(isDiskConflict("")).toBe(false);
  });
});
