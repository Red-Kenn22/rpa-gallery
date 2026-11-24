import { changeText, contentText, destText, humanizeVar } from '../../lib/choiceText';
import type { ChoiceInfo, ScenePrograms, SceneInfo } from '../../types';

/** The "what does this lead to" lines under a menu choice or if-branch. */
export function ChoiceDetails({
  info,
  programs,
  scene,
  sceneById,
  titleForLabel,
}: {
  info: ChoiceInfo;
  programs: ScenePrograms;
  scene: SceneInfo;
  sceneById: (id: string) => SceneInfo | undefined;
  titleForLabel: (label: string) => string | undefined;
}) {
  const chips = [destText(info, titleForLabel), ...contentText(info)];
  const names = info.chars.map((c) => programs.speakers[c]?.name ?? c).slice(0, 3);
  const order = (id: string) => sceneById(id) ?? undefined;
  return (
    <span className="mt-1.5 block space-y-1 text-[11px] leading-snug font-normal" data-choice-info>
      <span className="flex flex-wrap gap-1">
        {chips.map((c, i) => (
          <span key={i} className={`rounded px-1.5 py-0.5 ${i === 0 ? (info.dest.k === 'rejoin' ? 'bg-white/10 text-neutral-200' : 'bg-amber-400/15 text-amber-200') : 'bg-white/10 text-neutral-300'}`}>
            {c}
          </span>
        ))}
        {names.map((n) => (
          <span key={n} className="rounded bg-rose-400/15 px-1.5 py-0.5 text-rose-200">
            {n}
          </span>
        ))}
      </span>
      {info.changes.length > 0 && (
        <span className="block text-emerald-300" data-changes>
          {info.changes.map(changeText).join(' · ')}
        </span>
      )}
      {info.usedIn.map((u) => {
        const titles = u.scenes.map((id) => (id === scene.id ? 'later in this scene' : order(id)?.title ?? id));
        const shown = titles.slice(0, 2).join(', ');
        const more = u.total - Math.min(2, titles.length);
        return (
          <span key={u.v} className="block text-sky-300" data-used-in>
            {humanizeVar(u.v)} is checked in {shown}
            {more > 0 ? ` +${more} more` : ''}
          </span>
        );
      })}
      {info.deps?.map((d) => (
        <span key={d.v} className="block text-sky-300" data-deps>
          {humanizeVar(d.v)}:{' '}
          {d.setBy
            .slice(0, 2)
            .map((s) => `${s.change} by choosing “${s.choice}” in ${order(s.scene)?.title ?? s.scene}`)
            .join('; ')}
          {d.setBy.length > 2 ? ` (+${d.setBy.length - 2} more)` : ''}
        </span>
      ))}
    </span>
  );
}
