# WSG-NCC runtime redistribution notice

This directory contains WSG-NCC runtime data and Python source used by
AutoWSGR-GUI:

- `codebooks/cascade.npz` - SHA-256 `81f1b3fb027f79d85f42dca86dc237fab5e0b8fe6c2da5a7c8bc52ac10a5be4b`
- `gallery_meta.json` - SHA-256 `503f58607c637b6fa727663d09527dd48b093fde2c4ed96370732507b916bbe4`
- `python/cascade_ncc/` - Python runtime package `cascade-ncc` version `0.1.0`
- `python/SHA256SUMS` - complete SHA-256 manifest for the bundled Python runtime
- Python runtime tree digest - SHA-256 of `python/SHA256SUMS`: `feeaa1542d27ab832236db564842cfbfc6f3946c2849a7b5b41b336d8b288a9c`

Source project: <https://github.com/CV-souryu/WSG-NCC>

Bundled upstream commit: `939e0dcf8c45df4892638acce1c7ff6f4cd07c55`

The Python runtime was copied from an installed package whose `direct_url.json`
records that repository and exact commit. The WSG-NCC author has explicitly
authorized the AutoWSGR-GUI maintainer to redistribute these runtime files with
AutoWSGR-GUI. The maintainer holds the authorization evidence outside this
public repository.

This notice records that redistribution authorization only. It does not invent
or grant a software license, relicense WSG-NCC or these files, or extend the
authorization to other files.

To verify the bundled Python runtime from this directory, check every entry in
`python/SHA256SUMS`. The resource contract also verifies the exact file set,
file sizes, and hashes, so added, removed, or changed runtime files fail closed.
