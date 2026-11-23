import { parseRpy } from '../src/lib/rpyParser.ts';
import { buildScenes } from '../src/lib/sceneParser.ts';
const lines: string[] = ['init python:'];
for (let i = 0; i < 3000; i++) lines.push(i % 30 === 0 ? `    c${i} = Character("Char ${i}", color="#fff")` : `    v${i} = some_call(${i}, "x")`);
for (let l = 0; l < 1500; l++) {
  lines.push(`label scene_${l}:`, `    scene bg room${l % 50}`, `    show c${(l * 30) % 3000} happy`);
  for (let k = 0; k < 60; k++) lines.push(`    c${(k * 30) % 3000} "Line ${k} of scene ${l} with {i}tags{/i} and some words to make it realistic."`);
  lines.push(`    $ renpy.movie_cutscene("video/v${l % 20}.webm")`);
}
const src = lines.join('\n');
const paths = [...Array(50).keys()].map((i) => `images/bg room${i}.png`).concat([...Array(20).keys()].map((i) => `video/v${i}.webm`));
const assets = { resolve: (p: string) => paths.find((x) => x.toLowerCase() === p.toLowerCase() || x.toLowerCase() === `images/${p.toLowerCase()}`) ?? null, paths: () => paths };
let t = performance.now();
const stmts = parseRpy(src);
const t1 = performance.now() - t; t = performance.now();
const r = buildScenes([{ path: 'big.rpy', stmts }], assets);
const t2 = performance.now() - t;
console.log(`source ${(src.length / 1e6).toFixed(1)} MB: parseRpy ${t1.toFixed(0)} ms, buildScenes ${t2.toFixed(0)} ms, scenes ${r.scenes.length}, chars ${r.characters.length}, first scene videos ${r.scenes[0].videos}, bg ${r.scenes[0].backgrounds}`);
