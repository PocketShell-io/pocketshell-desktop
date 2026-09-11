import { ref, type Ref } from 'vue';
import { ReconnectBackoff } from '../shared/reconnectBackoff';

/**
 * The automatic reconnect loop: wait out the backoff curve, dial, repeat —
 * until the link comes back or the attempt budget is spent.
 *
 * This is the machinery half of the reconnect FSM; the DECISION half lives in
 * the connection store, which owns why the dialler is renderer-side at all
 * (one dialler per connection, and everything a reconnect has to revive is
 * already orchestrated by the store's `connect()` — see its header). The loop
 * itself knows nothing about SSH: it is given a `dial` and reports a schedule.
 *
 * The store binds {@link autoRetry} / {@link retryIn} / {@link recovering}
 * straight into its own state — `autoRetry` + `retryIn` are what the
 * lost-link banner renders as a countdown, and `recovering` is true from the
 * drop until recovery lands (or is cancelled), so the banner does not blink
 * off during each dial: state sits at 'connecting' while a scheduled retry is
 * on the wire, and a strip gated on `state === 'lost'` alone would disappear
 * exactly when it says "Reconnecting…".
 *
 * Every schedule step runs under a generation guard: a cancellation bumps the
 * generation, so a dial already in flight when the user disconnected (or hit
 * Retry now) cannot finish into state that no longer wants it — the same
 * guard the auto-connect latch uses.
 */
export class ReconnectLoop {
  /** The pending automatic retry, or null when no recovery is mid-flight. */
  readonly autoRetry: Ref<{ attempt: number; retryAt: number } | null> = ref(null);
  /** Seconds until the pending retry fires — the banner's countdown. */
  readonly retryIn: Ref<number> = ref(0);
  readonly recovering: Ref<boolean> = ref(false);

  private backoff: ReconnectBackoff | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;

  constructor(private readonly deps: ReconnectLoopDeps) {}

  /** True while a recovery curve is running (or paused on a spent budget). */
  get running(): boolean {
    return this.backoff != null;
  }

  /**
   * Begin the automatic recovery: fresh curve, first retry in 5s.
   *
   * Idempotent — main's keepalive and the wake probe can both report the same
   * dead link, and only one loop may own the schedule.
   */
  begin(): void {
    if (this.backoff || !this.deps.hasTarget()) return;
    this.backoff = new ReconnectBackoff();
    this.recovering.value = true;
    const gen = ++this.generation;
    this.scheduleNext(gen);
  }

  /**
   * Skip the wait: dial now, under the running curve's budget.
   *
   * A manual dial supersedes a pending automatic one without resetting the
   * curve: the user pressing the button 4s into a 5s wait is saying "now",
   * not "start the schedule over" — the budget only resets on success.
   */
  async skipWait(): Promise<void> {
    this.clearPendingStep();
    await this.dialStep(this.generation);
  }

  /**
   * Clear a not-yet-fired schedule step — for a manual dial that must
   * supersede the pending one without touching the running curve's state.
   */
  clearPendingStep(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopCountdown();
    this.autoRetry.value = null;
  }

  /** A dial succeeded: the curve is done and its budget resets. */
  succeeded(): void {
    this.backoff?.reset();
    this.backoff = null;
    this.autoRetry.value = null;
    this.recovering.value = false;
    this.stopCountdown();
  }

  /**
   * Tear down the automatic schedule — a user disconnect means it. The
   * generation bump also orphanes a dial already on the wire, whose success
   * would otherwise revive a connection the user just closed.
   */
  cancel(): void {
    this.generation += 1;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopCountdown();
    this.backoff = null;
    this.autoRetry.value = null;
    this.recovering.value = false;
  }

  /** Wait out the next step of the curve, then dial. */
  private scheduleNext(gen: number): void {
    const plan = this.backoff?.next();
    if (!plan) {
      this.giveUp(gen);
      return;
    }
    this.autoRetry.value = { attempt: plan.attempt, retryAt: plan.retryAtEpochMs };
    this.startCountdown(plan.retryAtEpochMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.stopCountdown();
      this.autoRetry.value = null;
      void this.dialStep(gen);
    }, plan.delayMs);
  }

  /** One dial inside the recovery loop. */
  private async dialStep(gen: number): Promise<void> {
    if (gen !== this.generation || !this.deps.hasTarget()) return;
    const ok = await this.deps.dial();
    if (gen !== this.generation) return;
    if (!ok) {
      // A failed dial leaves the link gone; the owner says so in its own
      // state (the banner and the next curve step both read it), and the
      // curve waits again.
      this.deps.onDialFailed();
      this.scheduleNext(gen);
    }
  }

  /**
   * The budget is spent: stop dialling and say so. Recovery is still
   * available to the user, but now it is their button, not a timer.
   */
  private giveUp(gen: number): void {
    if (gen !== this.generation) return;
    this.backoff = null;
    this.autoRetry.value = null;
    this.recovering.value = false;
    this.stopCountdown();
    this.deps.onGiveUp();
  }

  /** Stop the countdown ticker; safe to call when it is not running. */
  private stopCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.retryIn.value = 0;
  }

  /** The auto-reconnect countdown label ticks once a second. */
  private startCountdown(retryAt: number): void {
    this.stopCountdown();
    const tick = (): void => {
      this.retryIn.value = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    };
    tick();
    this.countdownTimer = setInterval(tick, COUNTDOWN_TICK_MS);
  }
}

const COUNTDOWN_TICK_MS = 1_000;

/** What the loop needs from its owner, and when it reports back. */
interface ReconnectLoopDeps {
  /** Whether there is anything to re-dial (a host is still active). */
  hasTarget: () => boolean;
  /** One re-dial attempt; false means the link is still down. */
  dial: () => Promise<boolean>;
  /** A dial came back false — the owner puts its state where the banner reads it. */
  onDialFailed: () => void;
  /** The attempt budget is spent — the owner hands recovery to the user's button. */
  onGiveUp: () => void;
}
