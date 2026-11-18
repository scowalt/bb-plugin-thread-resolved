---
name: thread-resolved
description: Read or refresh the Thread Resolved plugin's verdict on whether a bb thread's work is resolved or picked up by another thread. Use when asked why a thread shows (or lacks) the resolved checkmark.
---

# Thread Resolved

The plugin asks an OpenCode model, for every idle visible thread updated in the
last few days, "Is all of the work for this thread either resolved or picked up
by another thread?". Threads judged yes get a checkmark in the sidebar row and
a **Resolved** chip beside the composer. While a verdict is on its way (a few
seconds after a turn ends, or while the model reads the thread) the row shows a
spinner and the chip reads **Checking…**; a thread with no icon and no spinner
was judged open. Working threads, threads waiting on the person, and failed
threads show nothing.

A change counts as done only once it is in production and checked there;
written, committed or in a pull request is not done. A thread another thread
started for one part of a task is done once it reports back.

```sh
bb thread-resolved list [--json]               # threads judged resolved, with the reason
bb thread-resolved judging [--json]            # threads awaiting a fresh verdict
bb thread-resolved status <thread-id> [--json] # the stored verdict, reason, last error, and whether it is being re-judged
bb thread-resolved check <thread-id> [--json]  # ask the model again now
```

Settings (`bb plugin config thread-resolved`): `model` (default
`hy4-flash-free`), `baseUrl` (default OpenCode Go), `apiKey` (empty reads
OpenCode's saved key), `lookbackDays` (default 3).
