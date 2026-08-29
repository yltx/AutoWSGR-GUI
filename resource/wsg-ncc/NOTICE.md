# WSG-NCC runtime redistribution notice

This directory contains WSG-NCC runtime data and Python source used by
AutoWSGR-GUI:

- `LICENSE` - upstream MIT license
- `codebooks/cascade.npz` - SHA-256 `81f1b3fb027f79d85f42dca86dc237fab5e0b8fe6c2da5a7c8bc52ac10a5be4b`
- `gallery_meta.json` - SHA-256 `503f58607c637b6fa727663d09527dd48b093fde2c4ed96370732507b916bbe4`
- `python/cascade_ncc/` - Python runtime package `cascade-ncc` version `0.1.0`
- `python/SHA256SUMS` - complete SHA-256 manifest for the bundled Python runtime
- Python runtime tree digest - SHA-256 of `python/SHA256SUMS`: `b82027e0e883494fb01df6e1bd793101ed981f1642bbd0e230a554c22762aa3f`

Source project: <https://github.com/CV-souryu/WSG-NCC>

Bundled runtime/data content matches upstream release tag `v2026.08.28` at commit
`1739742a4aba63321b4ae67f590e899ac7dbefcb`. The same runtime/data files were
already present at commit `939e0dcf8c45df4892638acce1c7ff6f4cd07c55`.

The Python runtime and data are byte-identical to the files in the upstream
release above and are redistributed under the bundled MIT license. The
WSG-NCC author had also explicitly authorized the AutoWSGR-GUI maintainer to
redistribute these runtime files before the public license was added; the
maintainer holds that authorization evidence outside this public repository.

To verify the bundled Python runtime from this directory, check every entry in
`python/SHA256SUMS`. The resource contract also verifies the exact file set,
file sizes, and hashes, so added, removed, or changed runtime files fail closed.
