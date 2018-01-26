Goals, now:

- Speed is the #1 feature
- Annotate a GH commit with status information as quickly as possible
- Simple, even simplistic: bash scripts + GCP-hosted functions/storage. Your daemon is something like screen/tmux. Like fixing a bicycle (vs a car).
- New, arbitrarily different builds are easy to set up
- One click to see build output: build logs are available via the web, linked up in notifications / GH status detail
- Decent notification options (slack etc)
- Aimed at hermetic build environments (like bazel provides), where output can be reused across builds with a high degree of confidence

Goals, later:
- Multi-worker: Use sha files in gcs as the basis of a lease,
  Use gcs write preconditions to ensure only one worker owns a
  given sha at any given time. Renew lease every N seconds (15?)
  and other workers forcibly take over a sha at ~120s.
- Some docs around making a git-based build workflow based on this system