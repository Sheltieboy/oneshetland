import { track } from './analytics';
import { createAuthStageLogger } from './auth-stage';

/**
 * Sign-in stage diagnostics, wired to the app's existing channels: a
 * `[OneShetland]`-prefixed console line (the convention used throughout) and
 * the first-party `track()` client. `log_events` accepts unregistered event
 * names, so this needs no backend change. What may be recorded is fixed by the
 * allow-list in lib/auth-stage.ts.
 */
export const logAuthStage = createAuthStageLogger({
  log: (line) => console.log(line),
  track: (eventName, props) => track(eventName, { props }),
});
