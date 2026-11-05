// What a failed fetch really says. fetch only throws "fetch failed": the reason (DNS, a
// connection timeout, a reset) is in the error's `cause`, and a connection tried on several
// addresses keeps one error per address in `errors`.

const MAX_LENGTH = 300;
const MAX_DEPTH = 3;
const MAX_ADDRESSES = 3;

/** One error's own words, its code first when the message doesn't already say it. */
function own(err: object): string {
  const { code, message } = err as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  const name = typeof code === "string" ? code : "";
  if (name === "" || text.includes(name)) return text;
  return text === "" ? name : `${name}: ${text}`;
}

function reasons(err: unknown, depth: number): string[] {
  if (typeof err !== "object" || err === null || depth > MAX_DEPTH) return [];
  const { cause, errors } = err as { cause?: unknown; errors?: unknown };
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.slice(0, MAX_ADDRESSES).flatMap((e) => (typeof e === "object" && e !== null ? [own(e), ...reasons(e, depth + 1)] : []));
  }
  return [own(err), ...reasons(cause, depth + 1)];
}

/**
 * The reason behind an error, as " (reason)" to append to its message, or "" when it has none.
 * It can go into the log, the journal and a chat: a Telegram URL's bot token never does.
 */
export function causeOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const said = (err as { message?: unknown }).message;
  const parts = reasons((err as { cause?: unknown }).cause, 1).filter((r, i, all) => r !== "" && r !== said && all.indexOf(r) === i);
  if (parts.length === 0) return "";
  const text = parts.join("; ").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<token>");
  return ` (${text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text})`;
}
