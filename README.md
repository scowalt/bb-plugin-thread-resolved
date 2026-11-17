# Thread Resolved

A bb plugin that keeps asking a small model one question about each of your
threads:

> Is all of the work for this thread either resolved or picked up by another thread?

When the answer is yes, the thread gets a green check in its sidebar row and a
**Resolved** chip above the composer (click it for the model's one-line
reason). When the answer is no, nothing changes.

## How it decides

- **When it asks:** a few seconds after a thread goes idle, when one of its
  child threads goes idle or is archived, and on a one-minute sweep over every
  visible thread updated in the last `lookbackDays` days. The sweep asks again
  only when the thread or a related thread changed state since the last
  answer, so an unchanged thread costs no model call.
- **What the model reads:** the whole thread (user turns, messages from bb and
  other threads, agent replies, commands run, tool calls, files changed; file
  reads and reasoning are left out), capped at 100k characters by cutting the
  middle. It also gets each child thread and each thread the transcript
  mentions, with its state (running, idle, archived) and the end of its last
  reply.
- **When it shows nothing:** while the thread works, waits on you, has queued
  messages, or failed. A new turn clears the check at once.
- **Unsure means no.** The prompt tells the model to answer no when unsure.

## Model

Defaults to `hy4-flash-free` on OpenCode Go (`https://opencode.ai/zen/go/v1`),
which costs nothing. With no `apiKey` set, the plugin reads the key OpenCode
saved in `~/.local/share/opencode/auth.json`. Two checks run at a time; a 429
pauses all checks for 5 minutes.

```sh
bb plugin config thread-resolved set model beam-free
bb plugin config thread-resolved set lookbackDays 7
```

## CLI

```sh
bb thread-resolved list [--json]               # threads judged resolved, with the reason
bb thread-resolved status <thread-id> [--json] # stored verdict, reason, last error
bb thread-resolved check <thread-id> [--json]  # ask again now
```

## Develop

```sh
npm install --include=dev
npm test && npm run typecheck
bb plugin build . && bb plugin install . --yes
```
