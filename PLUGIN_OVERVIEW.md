A green check on every thread whose work is done or handed to another thread,
decided by a free OpenCode model that rereads the thread whenever it changes.

## What you get

- A check in the thread's sidebar row, in place of its status.
- A **Resolved** chip above the composer; click it for the reason.
- `bb thread-resolved` to list verdicts or re-check a thread.

## What it sends where

The thread's transcript (messages, commands, tool calls, file names) goes to
the OpenCode endpoint in settings, by default OpenCode Go.
