/**
 * A tiny, version-independent statement model. Both the pickled AST walker
 * (astWalker.ts) and the .rpy source fallback (rpyParser.ts) produce this;
 * sceneParser.ts and program.ts consume it. Control flow (menus, ifs) keeps
 * its structure so scenes can be played back.
 */

export interface MenuChoice {
  text: string;
  /** Python condition shown with the choice ("True" when unconditional). */
  cond: string | null;
  body: Stmt[];
}

export interface IfEntry {
  /** Python condition; "True" for `else`. */
  cond: string;
  body: Stmt[];
}

export type Stmt =
  | { k: 'label'; name: string; line: number; body: Stmt[] }
  | { k: 'say'; who: string | null; what: string; line: number }
  /** `scene` with no image clears the screen: name and expr are null. */
  | { k: 'scene'; name: string[] | null; expr: string | null; at: string[]; line: number }
  | { k: 'show'; name: string[]; expr: string | null; at: string[]; line: number }
  | { k: 'hide'; name: string[]; line: number }
  | { k: 'python'; source: string; line: number }
  | { k: 'define'; store: string; name: string; source: string; line: number }
  /** `image a b = expr` (source) or `image a b:` ATL (atl = quoted literals). */
  | { k: 'image'; name: string[]; source: string | null; atl: string[]; line: number }
  /** Creator-defined statements such as `play movie "x.webm"` or `pause`. */
  | { k: 'user'; text: string; line: number }
  | { k: 'menu'; choices: MenuChoice[]; line: number }
  | { k: 'if'; entries: IfEntry[]; line: number }
  | { k: 'while'; cond: string; body: Stmt[]; line: number }
  | { k: 'jump' | 'call'; target: string; line: number }
  | { k: 'return'; line: number };

export interface ScriptFile {
  /** Path inside the game directory, e.g. "script.rpyc". */
  path: string;
  stmts: Stmt[];
}

/** Child statement lists of a statement (for generic recursive walks). */
export function childBlocks(s: Stmt): Stmt[][] {
  switch (s.k) {
    case 'label':
    case 'while':
      return [s.body];
    case 'menu':
      return s.choices.map((c) => c.body);
    case 'if':
      return s.entries.map((e) => e.body);
    default:
      return [];
  }
}
