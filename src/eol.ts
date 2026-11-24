// Line endings: the editor works on "\n" only; files keep their own breaks, mixed ones included.
export type Eol = "\n" | "\r\n" | "\r";

/** Strip the BOM, normalize breaks to "\n", and return the dominant break plus the offsets (in the
 *  normalized text) of every "\n" that was a different break on disk. */
export function decodeRaw(raw: string) {
  const bom = raw.startsWith("﻿");
  const count: Record<Eol, number> = { "\n": 0, "\r\n": 0, "\r": 0 };
  const breaks: [number, Eol][] = [];
  let shift = 0;
  const text = (bom ? raw.slice(1) : raw).replace(/\r\n|\r|\n/g, (m: string, off: number) => {
    const e = m as Eol;
    count[e]++;
    breaks.push([off - shift, e]);
    shift += m.length - 1;
    return "\n";
  });
  const eol = (["\n", "\r\n", "\r"] as Eol[]).reduce((a, b) => (count[b] > count[a] ? b : a));
  return { text, bom, eol, odd: breaks.filter(b => b[1] !== eol) };
}

/** Inverse of decodeRaw: `odd` maps "\n" offsets to the break they had on disk. */
export const encodeEol = (text: string, eol: Eol, odd: Map<number, Eol>) =>
  odd.size ? text.replace(/\n/g, (_m: string, off: number) => odd.get(off) ?? eol) : text.replace(/\n/g, eol);
