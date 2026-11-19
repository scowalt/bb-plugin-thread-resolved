A green check on every thread whose work is done or handed to another thread,
decided by a free OpenCode decision model that rereads the thread whenever it changes.

## What you get

- A check in the thread's sidebar row, in place of its status.
- A **Resolved** chip above the composer with the model's confidence, or a
  progress ring, empty or filled by thirds, while the thread is open.
- The same ring on the sidebar row's metadata line, when that line is on.
- `bb thread-resolved` to list verdicts or re-check a thread.

## What it sends where

The thread's transcript (messages, commands, tool calls, file names) goes to
OpenCode's System One decision endpoint.
