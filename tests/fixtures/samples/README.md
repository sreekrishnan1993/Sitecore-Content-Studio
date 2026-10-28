# Sample documents (local regression fixtures)

Put real `.docx`, `.pdf` or `.html` files here to run them through the shared structure pipeline
with `npm test` (see `tests/structure.test.ts`, "sample …" cases). They are checked with
format-independent invariants only: at most one title, no runaway block count, and no source
text lost or duplicated. No test depends on a specific file name or its content.

Files in this folder are git-ignored (except this README) because real documents may be
confidential. Do not commit them unless they are cleared for sharing.
