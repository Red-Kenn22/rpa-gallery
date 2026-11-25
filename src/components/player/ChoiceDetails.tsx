import { changeChip, choiceVerdict, contentText, humanizeVar, type CharMatcher, type VerdictKind } from '../../lib/choiceText';
import { tagColors } from '../../lib/format';
import type { ChoiceInfo, ScenePrograms, SceneInfo } from '../../types';

const VERDICT_STYLE: Record<VerdictKind, string> = {
  leaves: 'bg-amber-400/20 text-amber-100',
  ends: 'bg-amber-400/20 text-amber-100',
  lasting: 'bg-emerald-400/20 text-emerald-100',
  untracked: 'bg-sky-400/15 text-sky-100',
  none: 'bg-white/10 text-neutral-300',
};

/** What a menu choice or if-branch leads to: a verdict first, then the details. */
export function ChoiceDetails({
  info,
  programs,
  scene,
  sceneById,
  titleForLabel,
  match,
  branch = false,
}: {
  branch?: boolean;
  info: ChoiceInfo;
  programs: ScenePrograms;
  scene: SceneInfo;
  sceneById: (id: string) => SceneInfo | undefined;
  titleForLabel: (label: string) => string | undefined;
  match: CharMatcher;
}) {
  const verdict = choiceVerdict(info, titleForLabel, scene.id, branch);
  const chips = info.changes.map((c) => changeChip(c, match));
  const names = info.chars.map((c) => programs.speakers[c]?.name ?? c).slice(0, 3);
  const length = info.lines ? `${info.lines} line${info.lines === 1 ? '' : 's'}` : info.images + info.videos ? 'images only' : '';
  const facts = [length, ...contentText(info), names.length ? `with ${names.join(', ')}` : ''].filter(Boolean);
  const titleOf = (id: string) => (id === scene.id ? 'later in this scene' : sceneById(id)?.title ?? id);
  return (
    <span className="mt-2 block space-y-1.5 text-[12px] leading-snug font-normal" data-choice-info>
      <span className={`inline-block rounded-md px-2 py-0.5 font-medium ${VERDICT_STYLE[verdict.k]}`} data-verdict={verdict.k}>
        {verdict.text}
      </span>
      {chips.length > 0 && (
        <span className="flex flex-wrap gap-1" data-changes>
          {chips.map((c, i) => (
            <span key={i} className="rounded px-1.5 py-0.5" style={tagColors(c.color)}>
              {c.text}
            </span>
          ))}
        </span>
      )}
      {info.usedIn.map((u) => {
        const titles = u.scenes.map(titleOf);
        const more = u.total - Math.min(2, titles.length);
        const owner = match(u.v);
        return (
          <span key={u.v} className="block text-emerald-200/80" data-used-in>
            {owner ? `${owner.who.name} ${owner.stat}` : humanizeVar(u.v)} is checked in {titles.slice(0, 2).join(', ')}
            {more > 0 ? ` +${more} more` : ''}
          </span>
        );
      })}
      {info.deps?.map((d) => {
        const owner = match(d.v);
        return (
          <span key={d.v} className="block text-sky-200/80" data-deps>
            {owner ? `${owner.who.name} ${owner.stat}` : humanizeVar(d.v)}:{' '}
            {d.setBy
              .slice(0, 2)
              .map((s) => `${s.change} by choosing “${s.choice}” in ${sceneById(s.scene)?.title ?? s.scene}`)
              .join('; ')}
            {d.setBy.length > 2 ? ` (+${d.setBy.length - 2} more)` : ''}
          </span>
        );
      })}
      {facts.length > 0 && <span className="block text-neutral-400" data-facts>{facts.join(' · ')}</span>}
    </span>
  );
}
