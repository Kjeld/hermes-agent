const DELETE = "\x7f";

// How long (ms) after a mobile IME / replacement event we treat subsequent
// terminal input as a candidate line-replacement rather than a plain append.
// Exported so the ChatPage integration and tests share one tunable value.
export const MOBILE_REPLACEMENT_WINDOW_MS = 350;

function chars(text: string): string[] {
  return Array.from(text);
}

function removeLastChar(text: string): string {
  const c = chars(text);
  c.pop();
  return c.join("");
}

 
function isPlainText(data: string): boolean {
  // eslint-disable-next-line no-control-regex -- terminal data may contain control chars
  return !/[\x00-\x1f\x7f]/.test(data);
}

function lastWordMatch(line: string): RegExpMatchArray | null {
  return line.match(/^(.*?)(\S+)(\s*)$/u);
}

function collapseDuplicatedFinalWord(text: string, previousLine: string): string {
  const match = text.match(/^(.*?)(\S+)(\s+)(\S+)(\s*)$/u);
  if (!match) return text;

  const [, prefix, first, , second, trailing] = match;
  if (first.toLocaleLowerCase() !== second.toLocaleLowerCase()) return text;
  // Only collapse a duplication the tracked line already ended with — i.e.
  // Gboard re-emitted the final word. Requiring a >=2-char word avoids
  // eating legitimate single-letter reduplication ("a a", "i i") that a
  // user may genuinely type inside the replacement window.
  if (first.length < 2) return text;
  if (!previousLine.trimEnd().toLocaleLowerCase().endsWith(first.toLocaleLowerCase())) {
    return text;
  }
  return `${prefix}${first}${trailing}`;
}

function replacementLineForMobileInput(
  currentLine: string,
  incoming: string,
): string | null {
  if (!currentLine || currentLine.length < 2 || !incoming) return null;

  const currentLower = currentLine.toLocaleLowerCase();
  const incomingLower = incoming.toLocaleLowerCase();

  if (incomingLower.startsWith(currentLower)) {
    return collapseDuplicatedFinalWord(incoming, currentLine);
  }

  const word = lastWordMatch(currentLine);
  if (!word) return null;

  const [, prefix, last, trailing] = word;
  if (trailing) return null;

  const incomingFirst = incoming.trimStart().split(/\s+/u)[0] ?? "";
  if (
    incomingFirst &&
    incomingFirst.toLocaleLowerCase() === last.toLocaleLowerCase()
  ) {
    return `${prefix}${collapseDuplicatedFinalWord(incoming, currentLine)}`;
  }

  return null;
}

export function shouldTreatInputAsMobileReplacement(
  inputType: string | undefined,
  data: string | null | undefined,
  isMobileLike: boolean,
): boolean {
  if (
    inputType === "insertReplacementText" ||
    inputType === "insertFromComposition" ||
    inputType === "insertCompositionText"
  ) {
    return true;
  }
  return isMobileLike && inputType === "insertText" && (data?.length ?? 0) > 1;
}

export function updatePtyInputLine(currentLine: string, data: string): string {
  // Escape sequences (arrow keys, home/end, function keys, paste guards)
  // move the cursor or edit the line in ways this flat tracker cannot
  // model — and the per-char loop below would append their printable
  // payload (e.g. the "[D" of a left-arrow) as if it were typed text.
  // Reset instead: an unknown cursor position must disarm replacement
  // normalization until the user starts a fresh, cleanly-tracked line.
  if (data.includes("\x1b")) {
    return "";
  }
  let next = currentLine;
  // A fused CRLF/LFCR chunk is one Enter (see parse-keypress), not two
  // line endings — reset the tracked line once rather than twice so the
  // replacement tracker stays consistent with the enter fuser.
  if (data === "\r\n" || data === "\n\r") {
    return "";
  }
  for (const ch of chars(data)) {
    if (ch === "\r" || ch === "\n") {
      next = "";
    } else if (ch === DELETE || ch === "\b") {
      next = removeLastChar(next);
    } else if (ch === "\x15") {
      next = "";
    } else if (isPlainText(ch)) {
      next += ch;
    }
  }
  return next;
}

export function normalizePtyMobileInput(
  data: string,
  currentLine: string,
  replacementActive: boolean,
): { data: string; nextLine: string; normalized: boolean } {
  if (replacementActive && isPlainText(data)) {
    const replacementLine = replacementLineForMobileInput(currentLine, data);
    if (replacementLine !== null) {
      return {
        data: DELETE.repeat(chars(currentLine).length) + replacementLine,
        nextLine: replacementLine,
        normalized: true,
      };
    }
  }

  return {
    data,
    nextLine: updatePtyInputLine(currentLine, data),
    normalized: false,
  };
}

// How long (ms) a CR and its trailing LF may arrive apart and still count as
// one split CRLF Enter rather than two Enters. A human pressing Enter twice
// is far slower than xterm's two onData callbacks for one CRLF, and two
// identical bytes (CR CR / LF LF) are never fused — only CR+LF / LF+CR.
export const ENTER_SPLIT_WINDOW_MS = 60;

/**
 * Fuses a CRLF that Android/mobile terminals split across two xterm onData
 * callbacks (CR in one callback, LF in the next) into one Enter.
 *
 * The first line-ending byte is sent immediately (no latency added); only
 * the *second, opposite* line-ending byte arriving within the window is
 * swallowed — it is the carriage-return/newline half of the same Enter, not
 * a new keypress. Two identical bytes (CR CR / LF LF) are real double-Enters
 * and are never fused; a fused CRLF/LFCR chunk is one Enter and passes whole
 * (the parser already treats it as one, see parse-keypress).
 *
 * Also fuses the sticky-modifier case: a modified Enter (ESC + CR/LF, i.e.
 * Alt+Enter) can arrive as `\x1b\r` / `\x1b\n` in one callback with its
 * opposite line-ending half in the next. Without this the PTY sees a lone
 * Alt+Enter plus a separate Enter — the composer submits twice. The
 * opposite half is swallowed the same way as a bare split CRLF.
 */
export function createPtyEnterFuser(windowMs = ENTER_SPLIT_WINDOW_MS) {
  let last: { byte: string; at: number; expectHalf?: string } | null = null;

  return {
    /**
     * Process one chunk of PTY-bound input. Returns the chunk to actually
     * send, or "" when the chunk is the second half of a CRLF that was split
     * across callbacks (its CR/LF counterpart was already delivered).
     */
    process(data: string): string {
      // Modified-Enter (ESC + CR/LF) window: swallow exactly the CRLF half
      // we are waiting for; a non-matching CR/LF is a fresh Enter.
      if (last?.expectHalf && (data === "\r" || data === "\n")) {
        if (data === last.expectHalf && Date.now() - last.at <= windowMs) {
          return "";
        }
        last = null;
        return data;
      }
      if (data === "\r" || data === "\n") {
        if (
          last &&
          data !== last.byte &&
          Date.now() - last.at <= windowMs
        ) {
          return "";
        }
        last = { byte: data, at: Date.now() };
        return data;
      }
      if (data === "\r\n" || data === "\n\r") {
        last = { byte: data, at: Date.now() };
        return data;
      }
      // A modified Enter (ESC + CR or ESC + LF) split across callbacks:
      // keep the window open so its opposite CR/LF half is swallowed next.
      if (data === "\x1b\r" || data === "\x1b\n") {
        last = {
          byte: data,
          at: Date.now(),
          expectHalf: data === "\x1b\r" ? "\n" : "\r",
        };
        return data;
      }
      // Any other input ends the split-window: a later CR/LF is a real
      // Enter, not the echo of this chunk.
      last = null;
      return data;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Android raw-mode input workaround (`type="password"`)
//
// Android Chrome delivers typed input through a *hidden password input*
// instead of xterm's own textarea. A `<input type="password">` forces the
// Android keyboard into raw mode: every tap arrives as a per-character
// `input` event with `inputType === "insertText"` and `data` = that one
// character — no IME composition, no word-buffering-to-space, no
// `insertCompositionText`. This is the proven fix for the "no text types
// at all" Android problem (#137986): modern keyboards (SwiftKey, Gboard)
// hold letters in a composition until space, and xterm's `_inputEvent`
// handler (PR #6024, 6.1.0-beta.315) only sees `insertText`, not
// `insertCompositionText`. The password input sidesteps composition
// entirely, so per-character input reaches the PTY on ALL keyboards.
//
// `type="password"` only works on `<input>` elements — xterm's internal
// textarea (`createElement('textarea')`) cannot carry it (it's a no-op
// there), so we add a *separate* hidden password input and route focus +
// input through it, leaving xterm's textarea untouched.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map one KeyboardEvent to the PTY byte(s) it should send. Returns "" when
 * the keydown must be ignored because the character arrives separately as
 * an `input` event (letters/digits on a password input, which the browser
 * delivers per-tap).
 *
 * Only structural keys are handled here (Enter, backspace/delete, arrows,
 * Home/End, Tab, Ctrl+letter, and the IME "process" key that must be
 * swallowed so React's delegation doesn't mis-handle it).
 */
export function mapKeydownToPty(e: {
  key: string;
  keyCode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): string {
  const key = e.key;
  const ctrl = !!e.ctrlKey || !!e.metaKey;
  const alt = !!e.altKey;
  const shift = !!e.shiftKey;

  // IME/composition-in-progress signal: never let this reach React's
  // synthetic onCompositionStart (the #52111 guard), and never send it.
  if (e.keyCode === 229 || key === "Process") return "";

  if (ctrl && key === "Enter") return "\x0a"; // Ctrl+Enter -> LF
  if (key === "Enter" || key === "Return") return "\r";
  if (key === "Backspace") return "\x7f";
  if (key === "Delete") return "\x1b[3~";
  if (key === "Tab") return shift ? "\x1b[Z" : "\t";

  if (ctrl && key.length === 1 && /[a-zA-Z]/.test(key)) {
    // Ctrl+letter -> control character (Ctrl+A = \x01 ... Ctrl+Z = \x1a).
    const code = key.toUpperCase().charCodeAt(0) - 64;
    return String.fromCharCode(code);
  }
  if (ctrl && key === "Space") return "\x00";

  if (key === "ArrowUp") return alt ? "\x1b[1;3A" : "\x1b[A";
  if (key === "ArrowDown") return alt ? "\x1b[1;3B" : "\x1b[B";
  if (key === "ArrowRight") return alt ? "\x1b[1;3C" : "\x1b[C";
  if (key === "ArrowLeft") return alt ? "\x1b[1;3D" : "\x1b[D";

  if (key === "Home") return "\x1b[H";
  if (key === "End") return "\x1b[F";
  if (key === "PageUp") return "\x1b[5~";
  if (key === "PageDown") return "\x1b[6~";

  if (key === "Escape") return "\x1b";

  // Printable characters are delivered via the `input` event on a password
  // input — do not double-send them from keydown.
  if (key.length === 1) return "";
  // Function keys (F1-F12): send their CSI sequences.
  if (/^F([1-9]|1[0-2])$/.test(key)) {
    const n = parseInt(key.slice(1), 10);
    const code = n <= 9 ? n : n === 10 ? 21 : n === 11 ? 23 : 24;
    return `\x1b[${code}~`;
  }
  return "";
}

/**
 * Map one `input` event (with its InputEvent `inputType` + `data`) to the
 * PTY bytes to send, given the element's current value. Returns "" when the
 * event carries no typed input.
 *
 * On a password input Android delivers each tap as `inputType ===
 * "insertText"` with `data` = that one character (no composition). We send
 * it immediately and (in the DOM wrapper) reset the value so nothing
 * accumulates. Backspace arrives as `deleteContentBackward`.
 */
export function mapInputEventToPty(
  inputType: string | undefined,
  data: string | null | undefined,
  value: string,
): string {
  if (inputType === "insertText" || inputType === "insertReplacementText") {
    return data ?? "";
  }
  if (inputType === "insertFromPaste" || inputType === "insertFromDrop") {
    // Paste on a password input: the whole accumulated value is the paste.
    return value;
  }
  if (
    inputType === "deleteContentBackward" ||
    inputType === "deleteContentForward"
  ) {
    return "\x7f";
  }
  // insertCompositionText / insertFromComposition should not occur on a
  // password input (that is the entire point of raw mode); if one does,
  // forward its data defensively so nothing is dropped.
  if (
    inputType === "insertCompositionText" ||
    inputType === "insertFromComposition"
  ) {
    return data ?? "";
  }
  return "";
}

const PASSWORD_INPUT_ID = "hermes-mobile-raw-input";

/**
 * Create a hidden `<input type="password">` that captures Android raw-mode
 * input and forwards it via `onInput(data)`. Returns null when the browser
 * is not a touch/mobile client (desktop keeps xterm's own textarea path).
 *
 * The element is visually hidden but focusable; focusing it opens the soft
 * keyboard in raw mode. Every typed character is forwarded per-tap and the
 * element is reset to empty so nothing accumulates. `dispose()` removes the
 * element and all listeners.
 */
export function createMobilePasswordInput(
  isMobile: boolean,
  onInput: (data: string) => void,
): {
  element: HTMLInputElement;
  focus(): void;
  dispose(): void;
} | null {
  if (!isMobile || typeof document === "undefined") return null;

  const el = document.createElement("input");
  el.type = "password";
  el.id = PASSWORD_INPUT_ID;
  el.setAttribute("aria-label", "Terminal input (raw mode)");
  // `new-password` (not `off`) is the only autocomplete value Chrome's
  // password manager actually respects for suppressing the "save password"
  // prompt on a password input — `off` is ignored there by design. It tells
  // Chrome this is not a credential to remember. `data-form-type="other"`
  // additionally signals the field is not part of a login form.
  el.setAttribute("autocomplete", "new-password");
  el.setAttribute("data-form-type", "other");
  el.setAttribute("autocapitalize", "off");
  // Visually hidden but focusable — the keyboard opens on this element.
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.width = "1px";
  el.style.height = "1px";
  el.style.opacity = "0";
  el.style.border = "0";
  el.style.padding = "0";
  el.tabIndex = 0;
  document.body.appendChild(el);

  const handleInput = (ev: Event) => {
    const input = ev as InputEvent;
    const data = mapInputEventToPty(input.inputType, input.data, el.value);
    // Reset the accumulator so the next tap starts clean; keep caret at 0.
    el.value = "";
    if (el.setSelectionRange) el.setSelectionRange(0, 0);
    if (data) onInput(data);
  };
  const handleKeydown = (ev: KeyboardEvent) => {
    const data = mapKeydownToPty({
      key: ev.key,
      keyCode: ev.keyCode,
      ctrlKey: ev.ctrlKey,
      metaKey: ev.metaKey,
      altKey: ev.altKey,
      shiftKey: ev.shiftKey,
    });
    if (data) {
      ev.preventDefault();
      onInput(data);
    } else if (ev.keyCode === 229 || ev.key === "Process") {
      ev.preventDefault();
    }
  };

  el.addEventListener("input", handleInput);
  el.addEventListener("keydown", handleKeydown);

  return {
    element: el,
    focus() {
      el.focus();
    },
    dispose() {
      el.removeEventListener("input", handleInput);
      el.removeEventListener("keydown", handleKeydown);
      el.remove();
    },
  };
}
