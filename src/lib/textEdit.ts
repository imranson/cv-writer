export interface TextEdit {
  find: string;
  replace: string;
  /** Replace every occurrence instead of requiring a unique match. */
  all?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

/**
 * Applies exact find/replace edits in order. Each `find` must match exactly once
 * unless `all` is set, so the caller can't silently edit the wrong spot.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  let result = text;
  edits.forEach((edit, i) => {
    const label = `Edit ${i + 1}`;
    if (edit.find === '') throw new Error(`${label}: "find" must not be empty`);
    const count = countOccurrences(result, edit.find);
    if (count === 0) throw new Error(`${label}: text to find was not found (it must match exactly, including whitespace)`);
    if (count > 1 && !edit.all) {
      throw new Error(`${label}: text to find occurs ${count} times; include more surrounding text or set "all": true`);
    }
    result = edit.all ? result.split(edit.find).join(edit.replace) : result.replace(edit.find, () => edit.replace);
  });
  return result;
}
