# @palforge/core

- `ChildProcessSpawner.string` ignores non-zero exit codes. `RemoteShell` checks `exitCode` itself; do the same for any new process call.
