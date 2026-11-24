---
name: thread-resolved
description: Read or refresh the Thread Resolved plugin's verdict on whether a bb thread's work is resolved or picked up by another thread. Use when asked why a thread shows (or lacks) the resolved checkmark.
---

# Thread Resolved

The plugin asks an OpenCode decision model, for every idle visible thread
updated in the last few days, "Is all of the work for this thread either
resolved or picked up by another thread?". The model answers with a confidence
from 0 to 1. It also picks the most likely of four levels of how much of the
work is done: none, some, most (a final step left), all of it; `progress` is
0, 1/3, 2/3 or 1. Threads at or above `threshold` get a checkmark in the sidebar
row and a **Resolved** chip beside the composer; threads below it get a progress
ring, with no number, in the chip and in the sidebar row where the check would go. While a verdict is on its way (a few
seconds after a turn ends, or while the model reads the thread) the row shows a
spinner and the chip reads **Checking…**. Working threads, threads waiting on the person, and failed
threads show nothing.

A change counts as done only once it is in production and checked there;
written, committed or in a pull request is not done. A thread another thread
started for one part of a task is done once it reports back.

```sh
bb thread-resolved list [--json]               # threads judged resolved, with confidence and progress
bb thread-resolved judging [--json]            # threads awaiting a fresh verdict
bb thread-resolved status <thread-id> [--json] # the stored confidence and progress, last error, and whether it is being re-judged
bb thread-resolved check <thread-id> [--json]  # ask the model again now
```

Settings (`bb plugin config thread-resolved`): `decisionModel` (default
`opencode-go/jev-1.14`), `checksPerDay` (default 500), `threshold` (default
0.7), `apiKey` (empty reads OpenCode's saved key), `lookbackDays` (default 3).
