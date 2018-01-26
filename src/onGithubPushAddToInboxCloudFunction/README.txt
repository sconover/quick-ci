This is a cloud function that runs by being registered as a github webhook,
invoked whenever a new commit is submitted to a project.

The function evaluates the commit, and if a git-ref associate with the commit
matches the configured regex filter, it creates a file named after the git-sha, with
the full path:

inbox/git-sha

in the configured GCS bucket.


