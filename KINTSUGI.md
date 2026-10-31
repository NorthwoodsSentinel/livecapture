# KINTSUGI

Repairs in this repo are marked, not hidden. Each fix carries the same gold line in three
places: a `kintsugi:` comment at the repair site, a `Kintsugi:` trailer on the commit, and a
row here. Where the repair has no comment syntax (a lockfile, package.json), the seam lives
in the trailer and this ledger only. The ledger is append-only.

A row never claims a review before one exists. Review status names the reviewer, the verdict
and the reviewed SHA. Security repairs describe the class of fix, never how to exploit the break.

| Date | What broke | How it was mended | Mended by / reviewed by | Gold line |
|---|---|---|---|---|
| 2026-10-31 | The toolchain lockfile held known-vulnerable packages. | Refreshed the lock; wrangler 4.156, workers-types v5, Node 22 (c1c8019, d245616, 2e6c247). | CeeCee / Codex audit of d245616: fail (HIGH no runtime tests, non-security, ticketed; MEDIUM peer range, fixed in 2e6c247) | old threads frayed where no one was pulling — / rewoven now, the pattern held. |
