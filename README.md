# Thread Resolved

A bb plugin that keeps asking a small model one question about each of your
threads:

> Is all of the work for this thread either resolved or picked up by another thread?

When the answer is yes, the thread gets a green check in its sidebar row and a
**Resolved** chip above the composer (click it for the model's one-line
reason). When the answer is no, nothing changes.

## Install

```sh
bb plugin install 'git:https://github.com/scowalt/bb-plugin-thread-resolved.git@^0.1.0'
bb plugin update thread-resolved   # later releases in the same range
```

## How it decides

- **When it asks:** a few seconds after a thread goes idle, when one of its
  child threads goes idle or is archived, and on a one-minute sweep over every
  visible thread updated in the last `lookbackDays` days. The sweep asks again
  only when the thread or a related thread changed state since the last
  answer, so an unchanged thread costs no model call.
- **What the model reads:** the whole thread (user turns, messages from bb and
  other threads, agent replies, commands run, tool calls, files changed; file
  reads and reasoning are left out), capped at 100k characters by cutting the
  middle. It also gets the parent thread, each child thread and each thread the transcript
  mentions, with its state (running, idle, archived) and the end of its last
  reply.
- **When it shows nothing:** while the thread works, waits on you, has queued
  messages, or failed. A new turn clears the check at once.
- **What counts as done:** an answered question, review or piece of research
  is done, unless the answer hands you action items, a to-do list, decisions
  or open questions; those keep the thread open until you say each is done,
  tracked elsewhere or dropped. A change is done only once it is in production (merged and
  deployed, released, published or installed) and someone checked it works
  there. Written, tested, committed, pushed or in a pull request is not done.
  A thread another thread started for one part of a task is done once it
  reports back; shipping is the starting thread's job.
- **Unsure means no.** The prompt tells the model to answer no when unsure.
- **New prompt, new answers.** Every stored verdict carries a hash of the
  prompt, so a release that changes the prompt re-judges each thread once.

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
npm ci
npm run check                      # typecheck, tests, bb plugin build
npm run check:git-install          # build as a git install does, without dev dependencies
bb plugin install . --yes
```

Before changing the prompt in `src/judge.ts`, replay it on real threads. This
re-judges each thread with this checkout's prompt and prints one JSON verdict
per line, without touching stored verdicts:

```sh
bb thread-resolved list --json | jq -r '.[].threadId' | npx tsx scripts/replay.ts
```

## Release

```sh
npm version patch                  # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The Release workflow checks the tag matches `package.json`, runs `npm run
check`, and publishes a GitHub release. bb installs from the tag itself, so
never move a published tag; ship a fix as a new version.

## License

MIT
