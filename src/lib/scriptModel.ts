/**
 * A tiny, version-independent statement model. Both the pickled AST walker
 * (astWalker.ts) and the .rpy source fallback (rpyParser.ts) produce this,
 * and sceneParser.ts consumes it.
 */

export type Stmt =
  | { k: 'label'; name: string; line: number; body: Stmt[] }
  | { k: 'say'; who: string | null; what: string; line: number }
  /** `scene` with no image clears the screen: name and expr are null. */
  | { k: 'scene'; name: string[] | null; expr: string | null; line: number }
  | { k: 'show'; name: string[]; expr: string | null; line: number }
  | { k: 'python'; source: string; line: number }
  | { k: 'define'; store: string; name: string; source: string; line: number }
  /** `image a b = expr` (source) or `image a b:` ATL (atl = quoted literals). */
  | { k: 'image'; name: string[]; source: string | null; atl: string[]; line: number }
  /** Creator-defined statements such as `play movie "x.webm"`. */
  | { k: 'user'; text: string; line: number }
  | { k: 'menu'; choices: string[]; line: number }
  | { k: 'jump' | 'call'; target: string; line: number };

export interface ScriptFile {
  /** Path inside the archive, e.g. "script.rpyc". */
  path: string;
  stmts: Stmt[];
}
