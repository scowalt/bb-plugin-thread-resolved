# Thread Resolved

A bb plugin that keeps asking a decision model two questions about each of your
threads:

> Is all of the work for this thread either resolved or picked up by another thread?
>
> How much of the work the person asked for in this thread is finished?

The model answers the first with its confidence that the answer is yes. At 70%
or more, the thread gets a green check in its sidebar row and a **Resolved**
chip above the composer showing that confidence. Below the threshold, the chip
shows a progress ring instead, empty or filled a third, two thirds or all the
way, and so does the sidebar row's metadata line (Organize → Rows → Metadata,
where bb offers it). While an answer is on its
way (a few seconds after a turn ends, or while the model reads the thread) the
row shows a spinner and the chip reads **Checking…**.

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
  reads and reasoning are left out), capped at 60k characters by cutting the
  middle. A thread the model finds too long is asked again at 30k, then 15k. It also gets the parent thread, each child thread and each thread the transcript
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
- **How much is done:** the model weighs four levels: none of it done, some of
  it done, most of it done with one final step left (shipping, checking, a
  decision, or action items for you), and all of it done. The ring shows the
  level it finds most likely, never a point between two. The levels fit any
  task, not only code.
- **Unsure means no.** A confidence below `threshold` (default 0.7) shows
  nothing. Changing `threshold` takes effect at once, without asking again.
- **New question, new answers.** Every stored verdict carries a hash of the
  question and its criteria, so a release that changes them re-judges each
  thread once.

## Model

Defaults to `jev-1.13-free`, a free decision model on OpenCode's System One
endpoint (`https://opencode.ai/inference/systemone/v1/systemone`). It answers
in a few hundred milliseconds. The paid `jev-1.13`, `gpt-6-luna-decision` and
`gemini-decision-1` take the same request. With no `apiKey` set, the plugin
reads the key OpenCode saved in `~/.local/share/opencode/auth.json`. Two checks
run at a time; a 429 pauses all checks for 5 minutes.

```sh
bb plugin config thread-resolved set decisionModel jev-1.13
bb plugin config thread-resolved set threshold 0.8
bb plugin config thread-resolved set lookbackDays 7
```

## CLI

```sh
bb thread-resolved list [--json]               # threads judged resolved, with confidence and progress
bb thread-resolved judging [--json]            # threads awaiting a fresh verdict
bb thread-resolved status <thread-id> [--json] # stored confidence and progress, last error
bb thread-resolved check <thread-id> [--json]  # ask again now
```

## Develop

```sh
npm ci
npm run check                      # typecheck, tests, bb plugin build
npm run check:git-install          # build as a git install does, without dev dependencies
bb plugin install . --yes
```

Before changing the question or criteria in `src/judge.ts`, replay them on real
threads. This re-judges each thread with this checkout's question and prints
one JSON confidence per line, without touching stored verdicts:

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
