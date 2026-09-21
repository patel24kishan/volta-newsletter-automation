/**
 * Runs work one piece at a time, in the order it arrived. A piece that fails does not stop the
 * ones queued behind it. Used to handle Slack clicks one at a time, so a handler that waits on
 * Slack or Mailchimp between reading state and changing it cannot interleave with another.
 */
export function serialQueue(): (work: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (work) => {
    const run = tail.then(work);
    tail = run.catch(() => undefined);
    return run;
  };
}
