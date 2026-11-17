---
name: thread-resolved
description: Read or refresh the Thread Resolved plugin's verdict on whether a bb thread's work is resolved or picked up by another thread. Use when asked why a thread shows (or lacks) the resolved checkmark.
---

# Thread Resolved

The plugin asks an OpenCode model, for every idle visible thread updated in the
last few days, "Is all of the work for this thread either resolved or picked up
by another thread?". Threads judged yes get a checkmark in the sidebar row and
a **Resolved** chip beside the composer. Working threads, threads waiting on
the person, and failed threads show nothing.

```sh
bb thread-resolved list [--json]               # threads judged resolved, with the reason
bb thread-resolved status <thread-id> [--json] # the stored verdict, reason and last error
bb thread-resolved check <thread-id> [--json]  # ask the model again now
```

Settings (`bb plugin config thread-resolved`): `model` (default
`hy4-flash-free`), `baseUrl` (default OpenCode Go), `apiKey` (empty reads
OpenCode's saved key), `lookbackDays` (default 3).
