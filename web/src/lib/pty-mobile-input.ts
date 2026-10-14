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

/**
 * Android Chrome + Gboard deliver plain taps as `beforeinput` (`inputType:
 * "insertText"`) + `input` events ONLY — no keydown (not even keyCode 229)
 * and no `compositionstart`/`compositionend`. xterm.js emits onData only
 * from keydown/composition paths, and the compositionend fallback never
 * fires, so on such devices NO text reaches the PTY at all. Feed these
 * beforeinput commits through the composition forwarder instead.
 *
 * Returns the composition commit to forward, or null when the event is not
 * a Gboard plain-tap commit (backspace, selection edits, non-mobile, etc.).
 * `insertLineBreak` carries no text payload — it is an Enter (`\r`).
 */
export function beforeInputToCompositionCommit(
  inputType: string,
  data: string | null,
  isMobileLike: boolean,
): string | null {
  if (!isMobileLike) return null;
  if (inputType === "insertLineBreak") {
    return "\r";
  }
  if (
    inputType === "insertText" ||
    inputType === "insertCompositionText"
  ) {
    if (typeof data !== "string" || data.length === 0) return null;
    return data;
  }
  return null;
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
