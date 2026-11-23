// mend, the CLI SPEC.md specifies. Node 22, standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
function fileParts(text: string): { lines: string[]; br: string; end: boolean } {
  if (text === '') return { lines: [], br: '\n', end: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const end = text.endsWith(br);
  if (end) lines.pop();
  return { lines, br, end };
}

/** Section 5: a line as compared at a tier. */
function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

interface Occ {
  tier: number;
  positions: number[];
}

/** First tier at which O occurs (at or after `from`, ending at the last line when mustEnd), and where. */
function findTiers(lines: string[], O: string[], strict: boolean, from = 0, mustEnd = false): Occ | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i += 1) {
      if (mustEnd && i + O.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < O.length; k += 1) {
        if (norm(lines[i + k], tier) !== norm(O[k], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A line of N: a context line (written as the file's own line oi lines into the match) or a new line. */
interface NLine {
  ctx: boolean;
  oi: number;
  t: string;
}

const newLines = (ts: string[]): NLine[] => ts.map((t) => ({ ctx: false, oi: 0, t }));

/** N rendered: context lines from the file, and at tier 2 the re-indentation of section 5. */
function renderN(N: NLine[], fileLines: string[], i: number, tier: number | null, O: string[] | null): string[] {
  const f = fileLines[i];
  const F = f === undefined ? '' : leading(f);
  const P = O === null ? '' : O.length > 0 ? leading(O[0]) : '';
  return N.map((n) => {
    if (n.ctx) return fileLines[i + n.oi] ?? n.t;
    if (tier === 2 && n.t.trim() !== '' && n.t.startsWith(P)) return F + n.t.slice(P.length);
    return n.t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface UHunk {
  A: number;
  O: string[];
  N: NLine[];
  noEol: boolean;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: UHunk[];
  hasPair: boolean;
  hasHunk: boolean;
}

/** A `--- `/`+++ ` path: after the four characters, up to the first tab, trimmed; /dev/null means no file; a/ or b/ removed. */
function uniPath(raw: string): string | null {
  const t = raw.split('\t')[0].trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function unifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  let s: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      s = { oldPath: m[1], newPath: m[2], creation: false, deletion: false, hunks: [], hasPair: false, hasHunk: false };
      sections.push(s);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = uniPath(l.slice(4));
      const newP = uniPath(lines[i + 1].slice(4));
      if (s !== null && !s.hasPair && !s.hasHunk) {
        s.oldPath = oldP;
        s.newPath = newP;
        s.hasPair = true;
      } else {
        s = { oldPath: oldP, newPath: newP, creation: false, deletion: false, hunks: [], hasPair: true, hasHunk: false };
        sections.push(s);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (s === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@( .*)?$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1], 10);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const noEol = body.length > 0 && body[body.length - 1].startsWith('\\');
      const O: string[] = [];
      const N: NLine[] = [];
      let oi = 0;
      for (const b of body) {
        if (b.startsWith('\\')) continue;
        if (b === '' || b.startsWith(' ')) {
          const t = b === '' ? '' : b.slice(1);
          O.push(t);
          N.push({ ctx: true, oi, t });
          oi += 1;
        } else if (b.startsWith('-')) {
          O.push(b.slice(1));
          oi += 1;
        } else {
          N.push({ ctx: false, oi, t: b.slice(1) });
        }
      }
      s.hunks.push({ A, O, N, noEol });
      s.hasHunk = true;
      continue;
    }
    if (s !== null && !s.hasHunk) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ') && !s.hasPair) s.oldPath = l.slice(12).trim();
      else if (l.startsWith('rename to ') && !s.hasPair) s.newPath = l.slice(10).trim();
      else if (l.startsWith('new file mode')) s.creation = true;
      else if (l.startsWith('deleted file mode')) s.deletion = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** The hunks of a section apply in order, each to the result of the ones before it (section 6). */
function applyHunks(lines: string[], endBreak: boolean, hunks: UHunk[], strict: boolean, path: string): { lines: string[]; endBreak: boolean } {
  const out = [...lines];
  let d = 0;
  for (const h of hunks) {
    if (h.O.length > 0) {
      const res = findTiers(out, h.O, strict);
      if (res === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = res.positions[0];
      for (const p of res.positions) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const repl = renderN(h.N, out, best, res.tier, h.O);
      const touched = best + h.O.length === out.length;
      out.splice(best, h.O.length, ...repl);
      if (touched) endBreak = !h.noEol;
      d += h.N.length - h.O.length;
    } else {
      const p = Math.min(h.A + d, out.length);
      const ins = renderN(h.N, out, p, null, null);
      const atEnd = p === out.length;
      out.splice(p, 0, ...ins);
      if (atEnd) endBreak = !h.noEol;
      d += h.N.length;
    }
  }
  return { lines: out, endBreak };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = unifiedSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => (tree: Tree) => {
    if (s.creation) {
      const p = s.newPath;
      if (p === null) throw new Fail('missing', s.oldPath ?? '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      let plus: string[] = [];
      for (const h of s.hunks) plus = plus.concat(h.N.filter((n) => !n.ctx).map((n) => n.t));
      const lastN: UHunk | null = [...s.hunks].reverse().find((h) => h.N.some((n) => !n.ctx)) ?? null;
      const noEol = lastN !== null ? lastN.noEol : false;
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (s.deletion) {
      const p = s.oldPath;
      if (p === null) throw new Fail('missing', s.newPath ?? '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const old = s.oldPath;
    const nw = s.newPath;
    if (old === null || nw === null) throw new Fail('missing', old ?? nw ?? '');
    if (!safe(old)) throw new Fail('unsafe', old);
    if (!safe(nw)) throw new Fail('unsafe', nw);
    const t = tree.get(old);
    if (t === null) throw new Fail('missing', old);
    if (old !== nw && tree.get(nw) !== null) throw new Fail('exists', nw);
    const parts = fileParts(t);
    const r = applyHunks(parts.lines, parts.end, s.hunks, strict, old);
    const content = r.lines.length === 0 ? '' : r.lines.join(parts.br) + (r.endBreak ? parts.br : '');
    if (old !== nw) {
      tree.now.set(nw, content);
      tree.now.set(old, null);
      tree.moves.push({ old, nw });
    } else {
      tree.now.set(old, content);
    }
  });
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

interface SRBlock {
  path: string;
  old: string[];
  new: string[];
}

function srBlocks(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let lastRep = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const sLine = i;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      let rep = -1;
      if (eq >= 0) {
        for (let j = eq + 1; j < lines.length; j += 1) {
          if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
            rep = j;
            break;
          }
        }
      }
      if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${sLine + 1}`);
      let path: string | null = null;
      for (let j = sLine - 1; j > lastRep; j -= 1) {
        const cand = lines[j];
        if (blank(cand)) continue;
        const t = cand.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${sLine + 1}`);
      blocks.push({ path, old: lines.slice(sLine + 1, eq), new: lines.slice(eq + 1, rep) });
      prevPath = path;
      lastRep = rep;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = srBlocks(lines);
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
      return;
    }
    const t = tree.get(b.path);
    if (t === null) throw new Fail('missing', b.path);
    const parts = fileParts(t);
    const res = findTiers(parts.lines, b.old, strict);
    if (res === null) throw new Fail('no-match', b.path);
    if (res.positions.length > 1) throw new Fail('ambiguous', b.path);
    const i = res.positions[0];
    const repl = renderN(newLines(b.new), parts.lines, i, res.tier, b.old);
    const out = [...parts.lines];
    out.splice(i, b.old.length, ...repl);
    tree.now.set(b.path, out.length === 0 ? '' : out.join(parts.br) + (parts.end ? parts.br : ''));
  });
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'del'; path: string }
  | { kind: 'upd'; path: string; moveTo: string | null; chunks: V4AChunk[] };

const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j])) {
      last = j;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      i += 1;
      const fl: string[] = [];
      while (i < last) {
        const b = lines[i];
        if (blank(b)) {
          fl.push('');
          i += 1;
          continue;
        }
        if (isSectionStart(b) || b.trim() === '*** End Patch') break;
        if (b.startsWith('+')) {
          fl.push(b.slice(1));
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fl.length > 0 && fl[fl.length - 1] === '') fl.pop();
      secs.push({ kind: 'add', path, lines: fl });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i += 1;
      while (i < last && blank(lines[i])) i += 1;
      if (i < last && !isSectionStart(lines[i]) && lines[i].trim() !== '*** End Patch') throw new Exit2(`error: parse ${i + 1}`);
      secs.push({ kind: 'del', path });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updLine = i;
      const path = l.slice(17).trim();
      i += 1;
      while (i < last && blank(lines[i])) i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice(13).trim();
        i += 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: { k: string; t: string }[] } | null = null;
      const close = (trimEnd: boolean): void => {
        if (cur === null) return;
        const body = [...cur.body];
        if (trimEnd) while (body.length > 0 && body[body.length - 1].k === 'blank') body.pop();
        const O: string[] = [];
        const N: NLine[] = [];
        let oi = 0;
        for (const e of body) {
          if (e.k === 'ctx' || e.k === 'blank') {
            O.push(e.t);
            N.push({ ctx: true, oi, t: e.t });
            oi += 1;
          } else if (e.k === 'old') {
            O.push(e.t);
            oi += 1;
          } else {
            N.push({ ctx: false, oi, t: e.t });
          }
        }
        chunks.push({ anchor: cur.anchor, eof: cur.eof, O, N });
        cur = null;
      };
      while (i < last) {
        const b = lines[i];
        if (isSectionStart(b) || b.trim() === '*** End Patch') break;
        if (b.trim() === '*** End of File') {
          close(false);
          cur = { anchor: null, eof: true, body: [] };
          i += 1;
          continue;
        }
        if (b.startsWith('@@')) {
          close(false);
          cur = { anchor: b.slice(2).trim(), eof: false, body: [] };
          i += 1;
          continue;
        }
        if (blank(b)) {
          if (cur !== null) cur.body.push({ k: 'blank', t: '' });
          i += 1;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          const k = b.startsWith(' ') ? 'ctx' : b.startsWith('-') ? 'old' : 'new';
          cur.body.push({ k, t: b.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      close(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine + 1}`);
      secs.push({ kind: 'upd', path, moveTo, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => (tree: Tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const t = tree.get(s.path);
    if (t === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const parts = fileParts(t);
    const out = [...parts.lines];
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null && c.anchor !== '') {
        const max = strict ? 0 : 2;
        let a = -1;
        for (let tier = 0; tier <= max && a < 0; tier += 1) {
          for (let j = cursor; j < out.length; j += 1) {
            if (norm(out[j], tier) === norm(c.anchor, tier)) {
              a = j;
              break;
            }
          }
        }
        if (a < 0) throw new Fail('no-match', s.path);
        cursor = a;
      }
      if (c.O.length > 0) {
        const res = findTiers(out, c.O, strict, cursor, c.eof);
        if (res === null) throw new Fail('no-match', s.path);
        const p = res.positions[0];
        const repl = renderN(c.N, out, p, res.tier, c.O);
        out.splice(p, c.O.length, ...repl);
        cursor = p + c.N.length;
      } else {
        const p = c.eof ? out.length : Math.min(cursor, out.length);
        const ins = renderN(c.N, out, p, null, null);
        out.splice(p, 0, ...ins);
        cursor = p + c.N.length;
      }
    }
    const content = out.length === 0 ? '' : out.join(parts.br) + (parts.end ? parts.br : '');
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, content);
      tree.now.set(s.path, null);
      tree.moves.push({ old: s.path, nw: s.moveTo });
    } else {
      tree.now.set(s.path, content);
    }
  });
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- invocation, output, atomicity

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const moves = tree.moves.filter(
    (m) => tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.nw) === null && tree.now.get(m.nw) !== null,
  );
  const moveNews = new Map(moves.map((m) => [m.nw, m.old] as const));
  const moveOlds = new Set(moves.map((m) => m.old));
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveNews.has(p)) rows.push(`R ${moveNews.get(p)} -> ${p}`);
    else if (!moveOlds.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
