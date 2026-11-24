/**
 * Level 1 scene player engine (no React, no DOM): runs compiled label
 * programs until the next point where the player waits for a tap or a choice.
 *
 *   – stops at dialogue, pauses, cutscenes, menus and `if` branches
 *   – an image-only beat (a new `scene` before any text) also waits for a tap
 *   – follows jumps inside the scene, calls/returns anywhere, fall-through
 *   – leaving the scene's labels ends playback and names the next label
 *   – every stop is snapshotted, so Back is exact
 *   – choices are remembered per fork, and `timeline()` simulates the whole
 *     scene (previous choice at each fork, else the first) for the scrubber
 */

import type { ScenePrograms, StagePos, Step } from '../types';

export interface Layer {
  tag: string;
  img: string | null;
  name: string | null;
  pos: StagePos | null;
}

export interface AudioState {
  files: string[];
  loop: boolean;
  /** Changes whenever playback (re)starts, so the UI knows to start it. */
  seq: number;
  /** A one-shot that already played at an earlier stop: let it finish, don't restart it. */
  done?: boolean;
}

export interface PlayerView {
  bg: Layer | null;
  layers: Layer[];
  /** A one-shot cutscene playing full screen. */
  video: { img: string | null; name: string } | null;
  say: { who: string | null; what: string } | null;
  menu: Extract<Step, { t: 'menu' }>['choices'] | null;
  branch: Extract<Step, { t: 'branch' }>['options'] | null;
  ended: { reason: 'end' | 'left-scene' | 'missing'; nextLabel?: string } | null;
  label: string;
  /** What each audio channel is playing at this stop. */
  audio: Record<string, AudioState>;
}

interface Frame {
  label: string;
  pc: number;
}

export interface State {
  stack: Frame[];
  view: PlayerView;
  /** Dialogue lines shown so far (for the progress bar). */
  lines: number;
  /** Text of the previous line, for `extend`. */
  lastSay: { who: string | null; what: string } | null;
  audioSeq: number;
}

export interface EngineOptions {
  /** Take the first branch of every `if` instead of asking. */
  autoBranch?: boolean;
}

export interface Timeline {
  /** Snapshot at every stop along the path. */
  stops: State[];
  /** Stops that are menus/if-branches; `chosen` = you picked it (else assumed). */
  forks: { i: number; chosen: boolean; kind: 'menu' | 'branch' }[];
  /** Simulation stopped early (very long scene). */
  truncated: boolean;
}

const MAX_HISTORY = 6000;
const MAX_STEPS_PER_ADVANCE = 20000;
const MAX_CALL_DEPTH = 64;

const clone = <T>(v: T): T => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export class PlayerEngine {
  private state: State;
  private history: State[] = [];
  private readonly programs: ScenePrograms;
  private readonly members: Set<string>;
  private readonly sceneLabels: string[];
  /** Remembered choices: fork key (`label:pc`) → option index. */
  readonly choices = new Map<string, number>();
  options: EngineOptions;

  constructor(programs: ScenePrograms, sceneLabels: string[], options: EngineOptions = {}) {
    this.programs = programs;
    this.sceneLabels = sceneLabels;
    this.members = new Set(sceneLabels);
    this.options = options;
    const entry = sceneLabels[0];
    this.state = {
      stack: [{ label: entry, pc: 0 }],
      view: { bg: null, layers: [], video: null, say: null, menu: null, branch: null, ended: null, label: entry, audio: {} },
      lines: 0,
      lastSay: null,
      audioSeq: 0,
    };
    this.run();
  }

  get view(): Readonly<PlayerView> {
    return this.state.view;
  }

  get linesShown(): number {
    return this.state.lines;
  }

  get canGoBack(): boolean {
    return this.history.length > 1;
  }

  /** Index of the current stop (matches `timeline().stops` while you follow it). */
  get position(): number {
    return this.history.length - 1;
  }

  /** Snapshots of every stop so far (for the history log). */
  get past(): readonly State[] {
    return this.history;
  }

  /** The text shown before the current stop (a menu's question). */
  get previousLine(): { who: string | null; what: string } | null {
    return this.state.lastSay;
  }

  /** Key of the fork the player is waiting on, if any. */
  forkKey(): string | null {
    const v = this.state.view;
    if (!v.menu && !v.branch) return null;
    const f = this.top();
    return `${f.label}:${f.pc}`;
  }

  /** Simulates the scene from the start: remembered choice at each fork, else the first option. */
  timeline(maxStops = 4000): Timeline {
    const sim = new PlayerEngine(this.programs, this.sceneLabels, { ...this.options });
    const forks: Timeline['forks'] = [];
    while (!sim.view.ended && sim.history.length < maxStops) {
      const key = sim.forkKey();
      if (key) {
        const v = sim.view;
        const count = (v.menu ?? v.branch)!.length;
        const remembered = this.choices.get(key);
        const chosen = remembered !== undefined && remembered < count;
        forks.push({ i: sim.history.length - 1, chosen, kind: v.menu ? 'menu' : 'branch' });
        sim.choose(chosen ? remembered! : 0);
      } else {
        const before = sim.history.length;
        sim.advance();
        if (sim.history.length === before) break; // no progress (shouldn't happen)
      }
    }
    return { stops: sim.history, forks, truncated: !sim.view.ended };
  }

  /** Jumps to stop `i` of a timeline; Back then walks back along that path. */
  jumpTo(i: number, timeline: Timeline): void {
    const target = timeline.stops[i];
    if (!target) return;
    this.history = timeline.stops.slice(0, i + 1);
    this.state = clone(target);
  }

  /** Tap: continue to the next stop (no-op while a menu or branch is open). */
  advance(): void {
    const v = this.state.view;
    if (v.ended || v.menu || v.branch) return;
    v.say = null;
    v.video = null;
    this.settleAudio();
    this.run();
  }

  /** Moving on: voice stops (as in Ren'Py); other one-shots finish but never restart. */
  private settleAudio(): void {
    const audio = this.state.view.audio;
    for (const ch of Object.keys(audio)) {
      if (ch === 'voice') delete audio[ch];
      else if (!audio[ch].loop) audio[ch] = { ...audio[ch], done: true };
    }
  }

  /** Picks a menu choice or `if` branch by index. */
  choose(i: number): void {
    const v = this.state.view;
    const opts = v.menu ?? v.branch;
    const opt = opts?.[i];
    if (!opt) return;
    const frame = this.top();
    this.choices.set(`${frame.label}:${frame.pc}`, i);
    frame.pc = opt.to;
    v.menu = null;
    v.branch = null;
    v.say = null;
    this.settleAudio();
    this.run();
  }

  back(): void {
    if (this.history.length < 2) return;
    this.history.pop();
    this.state = clone(this.history[this.history.length - 1]);
  }

  /** Images the next few stops are likely to show (for preloading). */
  upcoming(max = 3): string[] {
    const out: string[] = [];
    const frame = this.state.stack[this.state.stack.length - 1];
    if (!frame) return out;
    let label = frame.label;
    let pc = frame.pc;
    for (let guard = 0; guard < 400 && out.length < max; guard++) {
      const prog = this.programs.labels[label];
      if (!prog) break;
      if (pc >= prog.steps.length) {
        if (!prog.next) break;
        label = prog.next;
        pc = 0;
        continue;
      }
      const s = prog.steps[pc];
      if ((s.t === 'bg' || s.t === 'show' || s.t === 'video') && s.img && !out.includes(s.img)) out.push(s.img);
      if (s.t === 'goto') pc = s.to;
      else if (s.t === 'jump') {
        label = s.label;
        pc = 0;
      } else if (s.t === 'menu') pc = s.choices[0]?.to ?? pc + 1;
      else if (s.t === 'branch') pc = s.options[0]?.to ?? pc + 1;
      else pc++;
    }
    return out;
  }

  private top(): Frame {
    return this.state.stack[this.state.stack.length - 1];
  }

  private stop(): void {
    this.history.push(clone(this.state));
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  private end(reason: 'end' | 'left-scene' | 'missing', nextLabel?: string): void {
    this.state.view.ended = nextLabel ? { reason, nextLabel } : { reason };
    this.stop();
  }

  private goTo(label: string): boolean {
    if (!this.members.has(label)) {
      this.end('left-scene', label);
      return false;
    }
    const frame = this.top();
    frame.label = label;
    frame.pc = 0;
    this.state.view.label = label;
    return true;
  }

  private run(): void {
    const st = this.state;
    const v = st.view;
    let dirty = false; // visuals changed since the last stop

    for (let n = 0; n < MAX_STEPS_PER_ADVANCE; n++) {
      const frame = this.top();
      if (!frame) return this.end('end');
      const prog = this.programs.labels[frame.label];
      if (!prog) return this.end('missing', frame.label);

      if (frame.pc >= prog.steps.length) {
        if (prog.next) {
          if (!this.goTo(prog.next)) return;
          continue;
        }
        if (st.stack.length > 1) {
          st.stack.pop();
          v.label = this.top().label;
          continue;
        }
        return this.end('end');
      }

      const s = prog.steps[frame.pc];
      switch (s.t) {
        case 'bg':
          // A new full-screen image after visuals already changed = an image-only beat.
          if (dirty && (v.bg || v.layers.length)) return this.stop();
          v.bg = { tag: s.tag ?? 'bg', img: s.img, name: s.name, pos: null };
          v.layers = [];
          frame.pc++;
          dirty = true;
          break;
        case 'show': {
          const layer: Layer = { tag: s.tag, img: s.img, name: s.name, pos: s.pos };
          const i = v.layers.findIndex((l) => l.tag === s.tag);
          if (v.bg && v.bg.tag === s.tag) v.bg = layer;
          else if (i >= 0) v.layers[i] = layer;
          else v.layers.push(layer);
          frame.pc++;
          dirty = true;
          break;
        }
        case 'hide':
          v.layers = v.layers.filter((l) => l.tag !== s.tag);
          if (v.bg?.tag === s.tag) v.bg = null;
          frame.pc++;
          break;
        case 'say':
          v.say = s.extend && st.lastSay ? { who: s.who ?? st.lastSay.who, what: st.lastSay.what + s.what } : { who: s.who, what: s.what };
          st.lastSay = v.say;
          frame.pc++;
          st.lines++;
          return this.stop();
        case 'pause':
          frame.pc++;
          return this.stop();
        case 'video':
          v.video = { img: s.img, name: s.name };
          frame.pc++;
          return this.stop();
        case 'menu':
          v.menu = s.choices;
          return this.stop();
        case 'branch':
          if (this.options.autoBranch || s.options.length === 1) {
            frame.pc = s.options[0].to;
            break;
          }
          v.branch = s.options;
          return this.stop();
        case 'goto':
          frame.pc = s.to;
          break;
        case 'set':
          frame.pc++;
          break;
        case 'audio': {
          const cur = v.audio[s.ch];
          if (s.op === 'stop') delete v.audio[s.ch];
          else if (s.op === 'queue' && cur && !cur.done) {
            v.audio[s.ch] = { ...cur, files: [...cur.files, ...s.files], loop: s.loop ?? cur.loop };
          } else if (s.files.length) {
            v.audio[s.ch] = { files: s.files, loop: s.loop ?? this.programs.channels?.[s.ch] ?? s.ch === 'music', seq: ++st.audioSeq };
          }
          frame.pc++;
          break;
        }
        case 'jump':
          if (!this.goTo(s.label)) return;
          break;
        case 'call':
          frame.pc++;
          if (st.stack.length >= MAX_CALL_DEPTH || !this.programs.labels[s.label]) break;
          st.stack.push({ label: s.label, pc: 0 });
          v.label = s.label;
          break;
        case 'return':
          st.stack.pop();
          if (!st.stack.length) return this.end('end');
          v.label = this.top().label;
          break;
      }
    }
    // Runaway loop guard (e.g. a label that jumps to itself with no dialogue).
    this.end('end');
  }
}
