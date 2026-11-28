import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Check, ExternalLink, Share2 } from 'lucide-react';
import { api } from '../api/client';
import {
  credencePill,
  shortActorName,
  type ActorCard,
  type CompareResponse,
} from '../types';
import { SwimlaneCanvas } from '../components/SwimlaneCanvas';
import { CompareInspectorDrawer } from '../components/CompareInspectorDrawer';

type CompareLens = 'flowchart' | 'matrix' | 'split';

export function CompareDiff() {
  const [searchParams, setSearchParams] = useSearchParams();
  const handleA = searchParams.get('a') || 'dario-amodei';
  const handleB = searchParams.get('b') || 'eliezer-yudkowsky';

  const [actors, setActors] = useState<ActorCard[]>([]);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [lens, setLens] = useState<CompareLens>('flowchart');
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [focusClusterId, setFocusClusterId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listActors().then(setActors).catch(() => {});
  }, []);

  useEffect(() => {
    setError(null);
    setFocusClusterId(null);
    setSelectedClusterId(null);
    api
      .compare(handleA, handleB)
      .then((res) => {
        setData(res);
        // Auto-open the top disagreement in the inspector so the user immediately sees why they differ
        const topDisagreement = res.diff.top_cruxes.find(
          (c) => c.category === 'direct_crux_disagreement'
        );
        if (topDisagreement) {
          setSelectedClusterId(topDisagreement.cluster_id);
        }
      })
      .catch((e) => setError(e.message));
  }, [handleA, handleB]);

  function updateHandles(nextA: string, nextB: string) {
    setSearchParams({ a: nextA, b: nextB });
  }

  function handleShare() {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const selectedDiffNode =
    data?.diff.nodes.find((n) => n.cluster_id === selectedClusterId) ?? null;

  const shortA = data ? shortActorName(data.actor_a.display_name) : 'Person A';
  const shortB = data ? shortActorName(data.actor_b.display_name) : 'Person B';

  const directDisagreements =
    data?.diff.top_cruxes.filter((c) => c.category === 'direct_crux_disagreement') ?? [];

  return (
    <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
      {/* Top Comparison Selector & View Switcher */}
      <section className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4">
        <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-full border border-[var(--actor-a-border)]/50 bg-[var(--actor-a-bg)] px-3 py-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--actor-a-border)]" />
              <select
                value={handleA}
                onChange={(e) => updateHandles(e.target.value, handleB)}
                className="bg-transparent text-xs font-bold text-[var(--actor-a-text)] focus:outline-none"
              >
                {actors.map((a) => (
                  <option key={a.id} value={a.handle}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => updateHandles(handleB, handleA)}
              title="Swap"
              className="rounded-lg border border-[var(--border-hairline)] p-1.5 text-[var(--ink-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)]"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
            </button>

            <div className="flex items-center gap-2 rounded-full border border-[var(--actor-b-border)]/50 bg-[var(--actor-b-bg)] px-3 py-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--actor-b-border)]" />
              <select
                value={handleB}
                onChange={(e) => updateHandles(handleA, e.target.value)}
                className="bg-transparent text-xs font-bold text-[var(--actor-b-text)] focus:outline-none"
              >
                {actors.map((a) => (
                  <option key={a.id} value={a.handle}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-subtle)] p-0.5">
              {(
                [
                  ['flowchart', 'Flowchart'],
                  ['matrix', 'Table'],
                  ['split', 'Side-by-Side'],
                ] as [CompareLens, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setLens(k)}
                  className={`rounded-lg px-3 py-1 text-xs font-semibold transition ${
                    lens === k
                      ? 'bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-xs'
                      : 'text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              onClick={handleShare}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Share2 className="h-3.5 w-3.5" />}
              {copied ? 'Link Copied' : 'Share'}
            </button>

            <a
              href={`/og/compare?a=${encodeURIComponent(handleA)}&b=${encodeURIComponent(handleB)}`}
              target="_blank"
              rel="noreferrer"
              title="Open shareable PNG card"
              className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-hairline)] px-2.5 py-1.5 font-mono-meta text-[11px] text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)]"
            >
              Card PNG
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>

        {/* Plain-English Summary Strip + Earliest Split Diagnostic */}
        {data && (
          <div className="mt-3.5 space-y-2.5 border-t border-[var(--border-hairline)] pt-3 text-xs">
            {(() => {
              const drafts = [data.actor_a, data.actor_b].filter((a) => a.authorship_status === 'community_draft');
              if (drafts.length === 0) return null;
              const who =
                drafts.length === 2 ? 'Both maps are' : `${drafts[0].display_name}\u2019s map is`;
              return (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 font-medium text-amber-900">
                  {who} a best guess from public writing, not yet reviewed by the person.
                </p>
              );
            })()}
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[var(--bg-subtle)] px-3 py-1 font-semibold text-[var(--ink-primary)]">
                Both agree on {data.diff.summary.shared_ground_count}
              </span>
              {data.diff.summary.crux_disagreement_count > 0 && (
                <span className="rounded-full bg-[var(--semantic-disagree-bg)] px-3 py-1 font-semibold text-[var(--semantic-disagree-text)]">
                  Disagree on {data.diff.summary.crux_disagreement_count}
                </span>
              )}
              {directDisagreements.map((d) => {
                const active = focusClusterId === d.cluster_id;
                return (
                  <button
                    key={d.cluster_id}
                    onClick={() => {
                      setFocusClusterId((prev) => (prev === d.cluster_id ? null : d.cluster_id));
                      setSelectedClusterId(d.cluster_id);
                    }}
                    className={`rounded-full border px-3 py-1 font-semibold transition ${
                      active
                        ? 'border-rose-600 bg-rose-600 text-white'
                        : 'border-rose-200 bg-[var(--bg-surface)] text-[var(--ink-primary)] hover:border-rose-400'
                    }`}
                  >
                    Focus: {d.canonical_title}
                  </button>
                );
              })}
              {focusClusterId && (
                <button
                  onClick={() => setFocusClusterId(null)}
                  className="text-xs font-medium text-[var(--ink-muted)] underline"
                >
                  Show all
                </button>
              )}
            </div>

            {data.diff.summary.earliest_split && (
              <button
                type="button"
                onClick={() => {
                  const cid = data.diff.summary.earliest_split!.cluster_id;
                  setSelectedClusterId(cid);
                  setFocusClusterId((prev) => (prev === cid ? null : cid));
                }}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3.5 py-2 text-left transition hover:border-[var(--ink-primary)]/40"
              >
                <div className="flex items-center gap-2 text-xs text-[var(--ink-secondary)]">
                  <span className="rounded bg-[var(--ink-primary)] px-1.5 py-0.5 font-mono-meta text-[10px] font-bold uppercase text-white">
                    Earliest split
                  </span>
                  <span className="font-medium text-[var(--ink-primary)]">
                    {data.diff.summary.earliest_split.sentence}
                  </span>
                </div>
                <span className="shrink-0 font-mono-meta text-[10px] text-[var(--ink-muted)]">
                  Click to isolate →
                </span>
              </button>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-800">
          {error}
        </div>
      )}

      {data && (
        <div className="mt-4">
          {/* LENS 1: UNIFIED 5-COLUMN OVERLAY + INSPECTOR DRAWER */}
          {lens === 'flowchart' && (
            <div className={`grid gap-4 ${selectedDiffNode ? 'lg:grid-cols-[1fr_360px]' : 'grid-cols-1'}`}>
              <SwimlaneCanvas
                mode="compare"
                diff={data.diff}
                actorAShort={shortA}
                actorBShort={shortB}
                actorAFull={data.actor_a.display_name}
                actorBFull={data.actor_b.display_name}
                spotlightClusterId={focusClusterId}
                selectedClusterId={selectedClusterId}
                onSelectCluster={(cid) => setSelectedClusterId(cid)}
                defaultHeight={660}
              />
              {selectedDiffNode && (
                <CompareInspectorDrawer
                  diffNode={selectedDiffNode}
                  actorA={data.actor_a}
                  actorB={data.actor_b}
                  snapshotA={data.snapshot_a}
                  snapshotB={data.snapshot_b}
                  concepts={data.concepts}
                  onClose={() => setSelectedClusterId(null)}
                />
              )}
            </div>
          )}

          {/* LENS 2: PLAIN-ENGLISH TABLE COMPARISON */}
          {lens === 'matrix' && (
            <div className="overflow-hidden rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--border-hairline)] bg-[var(--bg-subtle)] font-mono-meta text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
                    <th className="px-4 py-3">Stage</th>
                    <th className="px-4 py-3">Claim / Step</th>
                    <th className="px-4 py-3">Comparison</th>
                    <th className="px-4 py-3 text-[var(--actor-a-text)]">{data.actor_a.display_name}</th>
                    <th className="px-4 py-3 text-[var(--actor-b-text)]">{data.actor_b.display_name}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-hairline)]">
                  {data.diff.nodes.map((dn) => (
                    <tr key={dn.cluster_id} className="hover:bg-[var(--bg-canvas)]">
                      <td className="px-4 py-3 font-mono-meta text-[10px] uppercase text-[var(--ink-muted)]">
                        {dn.stage}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          to={`/concept/${encodeURIComponent(dn.cluster_id)}`}
                          className="font-semibold text-[var(--ink-primary)] hover:underline"
                        >
                          {dn.canonical_title}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {dn.category === 'direct_crux_disagreement' && (
                          <span className="rounded-full bg-[var(--semantic-disagree-bg)] px-2 py-0.5 font-mono-meta text-[10px] font-semibold text-[var(--semantic-disagree-text)]">
                            Disagree
                          </span>
                        )}
                        {dn.category === 'shared_ground' && (
                          <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 font-mono-meta text-[10px] font-semibold text-[var(--ink-primary)]">
                            Both agree
                          </span>
                        )}
                        {(dn.category === 'unique_to_a' ||
                          dn.category === 'unique_to_b' ||
                          dn.category === 'unaddressed_load_bearing') && (
                          <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 font-mono-meta text-[10px] text-[var(--ink-muted)]">
                            {dn.node_a ? `Only ${shortA}` : `Only ${shortB}`}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {dn.node_a ? (
                          <div>
                            <span className="font-mono-meta font-semibold text-[var(--actor-a-text)]">
                              {dn.node_a.credence
                                ? credencePill(dn.node_a.credence)
                                : dn.node_a.bet_priority ?? dn.node_a.stance}
                            </span>
                            {dn.node_a.stance === 'rejected' && (
                              <span className="ml-1.5 text-[10px] text-rose-700">(Not betting on this)</span>
                            )}
                            {dn.node_a.note && (
                              <p className="mt-0.5 max-w-xs text-[11px] text-[var(--ink-secondary)]">
                                {dn.node_a.note}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-[var(--ink-muted)]">Not mentioned</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {dn.node_b ? (
                          <div>
                            <span className="font-mono-meta font-semibold text-[var(--actor-b-text)]">
                              {dn.node_b.credence
                                ? credencePill(dn.node_b.credence)
                                : dn.node_b.bet_priority ?? dn.node_b.stance}
                            </span>
                            {dn.node_b.stance === 'rejected' && (
                              <span className="ml-1.5 text-[10px] text-rose-700">(Not betting on this)</span>
                            )}
                            {dn.node_b.note && (
                              <p className="mt-0.5 max-w-xs text-[11px] text-[var(--ink-secondary)]">
                                {dn.node_b.note}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-[var(--ink-muted)]">Not mentioned</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* LENS 3: SIDE-BY-SIDE INDIVIDUAL FLOWCHARTS */}
          {lens === 'split' && (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-bold text-[var(--actor-a-text)]">
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--actor-a-border)]" />
                  <Link to={`/a/${data.actor_a.handle}`} className="hover:underline">
                    {data.actor_a.display_name}
                  </Link>
                </div>
                <SwimlaneCanvas
                  mode="single"
                  nodes={data.snapshot_a.nodes}
                  edges={data.snapshot_a.edges}
                  updateCriteria={data.snapshot_a.update_criteria}
                  concepts={data.concepts}
                  defaultHeight={460}
                />
              </div>
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-bold text-[var(--actor-b-text)]">
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--actor-b-border)]" />
                  <Link to={`/a/${data.actor_b.handle}`} className="hover:underline">
                    {data.actor_b.display_name}
                  </Link>
                </div>
                <SwimlaneCanvas
                  mode="single"
                  nodes={data.snapshot_b.nodes}
                  edges={data.snapshot_b.edges}
                  updateCriteria={data.snapshot_b.update_criteria}
                  concepts={data.concepts}
                  defaultHeight={460}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
