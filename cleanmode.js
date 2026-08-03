/* =============================================================================
 * cleanmode.js — hide the UI for screen recording
 * =============================================================================
 *
 * WHAT THIS IS FOR
 * The phone's own screen recorder captures the fully composited AR view at full
 * framerate, with audio, for free — but it also captures our buttons. Clean mode
 * hides every piece of on-screen UI so the recording contains nothing but the
 * real world and the model. Tapping anywhere brings the UI back.
 *
 * HOW THE HIDING WORKS
 * A single class on the overlay root. The CSS hides all its children EXCEPT the
 * transparent gesture layer, which we keep alive to catch the exit tap. The root
 * element itself is never display:none — WebXR is using it as the dom-overlay
 * target and Chrome checks that it is rendered.
 *
 * THE TAP GUARD
 * The tap that enters clean mode must not immediately exit it, and the user
 * needs a moment to reach the screen recorder in the notification shade. So the
 * exit listener is only attached after ENTRY_GRACE_MS.
 *
 * USAGE
 *   const clean = createCleanMode({ overlayEl, gestureEl, hintEl, onExit });
 *   clean.enter();
 *   clean.active   // boolean
 * ========================================================================== */

/** How long before a tap will exit clean mode. */
const ENTRY_GRACE_MS = 700;

/** How long the "tap to bring the UI back" hint stays up. Keep it short — it is
 *  visible to the screen recorder if the user starts recording immediately. */
const HINT_MS = 2200;

/**
 * @param {object}      opts
 * @param {HTMLElement} opts.overlayEl  the dom-overlay root
 * @param {HTMLElement} opts.gestureEl  transparent full-screen tap catcher
 * @param {HTMLElement} opts.hintEl     the fading instruction banner
 * @param {Function}    [opts.onEnter]
 * @param {Function}    [opts.onExit]
 */
export function createCleanMode({ overlayEl, gestureEl, hintEl, onEnter, onExit }) {
  let active = false;
  let armTimer = 0;
  let hintTimer = 0;

  /* Named so it can be removed again — an anonymous listener would leak and
   * fire on the next session. */
  function onTap(e) {
    e.preventDefault();
    exit();
  }

  function enter() {
    if (active) return;
    active = true;

    overlayEl.classList.add('clean');

    hintEl.textContent = 'UI hidden — tap anywhere to bring it back';
    hintEl.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove('on'), HINT_MS);

    /* Arm the exit tap only after the entry tap is long gone. */
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      if (!active) return;
      gestureEl.addEventListener('pointerdown', onTap, { passive: false });
    }, ENTRY_GRACE_MS);

    onEnter?.();
  }

  function exit() {
    if (!active) return;
    active = false;

    clearTimeout(armTimer);
    clearTimeout(hintTimer);
    gestureEl.removeEventListener('pointerdown', onTap);

    overlayEl.classList.remove('clean');
    hintEl.classList.remove('on');

    onExit?.();
  }

  return {
    enter,
    exit,
    toggle: () => (active ? exit() : enter()),
    get active() { return active; }
  };
}
