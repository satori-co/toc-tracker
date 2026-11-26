import { useEffect, useState } from 'react';
import { Check, FileText, Quote, Sparkles, Upload, X } from 'lucide-react';
import { api } from '../api/client';
import {
  credencePill,
  type AiStatusInfo,
  type Concept,
  type ExtractedDraft,
  type SnapshotEdge,
  type SnapshotNode,
  type SourceDocumentInput,
  type UpdateCriterion,
} from '../types';

interface CreateFromDocsPanelProps {
  conceptsMap: Record<string, Concept>;
  /** Claims already in the editor. When above zero, loading a draft asks whether to add or replace. */
  existingNodeCount?: number;
  onConceptsCreated: (created: Concept[]) => void;
  onApplyDraft: (payload: {
    summary: string;
    actorNameHint?: string | null;
    actorRoleHint?: string | null;
    nodes: SnapshotNode[];
    edges: SnapshotEdge[];
    updateCriteria: UpdateCriterion[];
    notice: string;
    /** 'add' keeps the map already in the editor and appends the new claims. */
    mode: 'replace' | 'add';
  }) => void;
  onClose: () => void;
}

export function CreateFromDocsPanel({
  conceptsMap,
  existingNodeCount = 0,
  onConceptsCreated,
  onApplyDraft,
  onClose,
}: CreateFromDocsPanelProps) {
  const [aiStatus, setAiStatus] = useState<AiStatusInfo | null>(null);
  const [urlsText, setUrlsText] = useState('');
  const [rawNotes, setRawNotes] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; text: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Review state
  const [draft, setDraft] = useState<ExtractedDraft | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.studioAiStatus().then(setAiStatus).catch(() => {});
  }, []);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    const loaded: { name: string; text: string }[] = [];
    for (const f of Array.from(files).slice(0, 10)) {
      const text = await f.text();
      loaded.push({ name: f.name, text });
    }
    setUploadedFiles((prev) => [...prev, ...loaded].slice(0, 10));
  }

  async function handleExtract(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const docs: SourceDocumentInput[] = [];
    const lines = urlsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('http://') || l.startsWith('https://'));
    for (const url of lines) {
      docs.push({ url });
    }
    for (const uf of uploadedFiles) {
      docs.push({ title: uf.name, text: uf.text });
    }
    if (rawNotes.trim()) {
      docs.push({ title: 'Pasted Notes', text: rawNotes.trim() });
    }

    if (docs.length === 0) {
      setError('Paste at least one URL, upload a .md/.txt file, or enter notes.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.studioExtract({ documents: docs });
      if (!res.used_llm && aiStatus?.llm_enabled) {
        // A model is configured but this request fell back to the keyword matcher,
        // which returns nearest-sounding existing claims, not claims read from the sources.
        // Showing those as a draft would put other people's views in this map.
        const reason = res.note && !res.note.startsWith('Local matcher') ? ` ${res.note}` : '';
        setError(
          `No draft was made, because the AI model did not answer.${reason} Your sources are still here. If this keeps happening, the site's model key needs attention.`
        );
        return;
      }
      setDraft(res);
      // Keyword-only guesses start unselected so each one is a deliberate choice.
      setSelectedNodeIds(res.used_llm ? new Set(res.nodes.map((n) => n.local_id)) : new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Extraction failed');
    } finally {
      setLoading(false);
    }
  }

  function toggleNode(localId: string) {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(localId)) next.delete(localId);
      else next.add(localId);
      return next;
    });
  }

  async function handleApply(mode: 'replace' | 'add' = 'replace') {
    if (!draft) return;
    if (
      mode === 'replace' &&
      existingNodeCount > 0 &&
      !window.confirm(
        `Replace the ${existingNodeCount} claim${existingNodeCount === 1 ? '' : 's'} already in your map? This cannot be undone.`
      )
    ) {
      return;
    }
    setApplying(true);
    try {
      const keptNodes = draft.nodes.filter((n) => selectedNodeIds.has(n.local_id));
      const usedTempIds = new Set(keptNodes.map((n) => n.concept_id));
      // Keep new claims local until the map is published. Creating them in the
      // catalog here left abandoned drafts in the shared vocabulary.
      const localConcepts: Concept[] = draft.proposed_concepts
        .filter((pc) => usedTempIds.has(pc.temp_id))
        .map((pc) => ({
          schema_version: 1,
          id: pc.temp_id,
          stage: pc.stage,
          title: pc.title,
          description: pc.description,
          parent_concept_id: pc.parent_concept_id ?? null,
          root_concept_id: pc.parent_concept_id ?? pc.temp_id,
          tags: [],
          created_at: new Date().toISOString(),
        }));

      if (localConcepts.length > 0) {
        onConceptsCreated(localConcepts);
      }

      const finalNodes = keptNodes;
      const keptSet = new Set(finalNodes.map((n) => n.local_id));
      const finalEdges = draft.edges.filter(
        (e) => keptSet.has(e.source_local_id) && keptSet.has(e.target_local_id)
      );
      const finalCriteria = draft.update_criteria.map((u) => ({
        ...u,
        target_local_id: u.target_local_id && keptSet.has(u.target_local_id) ? u.target_local_id : null,
      }));

      onApplyDraft({
        summary: draft.summary,
        actorNameHint: draft.actor_name_hint,
        actorRoleHint: draft.actor_role_hint,
        nodes: finalNodes,
        edges: finalEdges,
        updateCriteria: finalCriteria,
        notice: draft.note,
        mode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply draft');
    } finally {
      setApplying(false);
    }
  }

  function resolveTitle(conceptId: string): { title: string; isNew: boolean } {
    const existing = conceptsMap[conceptId];
    if (existing) return { title: existing.title, isNew: false };
    const proposed = draft?.proposed_concepts.find((p) => p.temp_id === conceptId);
    if (proposed) return { title: proposed.title, isNew: true };
    return { title: conceptId, isNew: false };
  }

  return (
    <div className="mb-4 rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-surface)] p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-bold text-[var(--ink-primary)]">Create from Documents</h3>
          {aiStatus && (
            <span
              className={`rounded-full px-2 py-0.5 font-mono-meta text-[10px] font-semibold ${
                aiStatus.llm_enabled
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'bg-[var(--bg-subtle)] text-[var(--ink-muted)]'
              }`}
            >
              {aiStatus.llm_enabled ? `${aiStatus.provider} · ${aiStatus.model}` : 'Local matcher (no LLM key set)'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!draft ? (
        <form onSubmit={handleExtract} className="mt-4 space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-[var(--ink-primary)]">
                Document URLs (up to 10, one per line)
              </label>
              <textarea
                rows={4}
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                placeholder={`https://lesswrong.com/posts/...\nhttps://redwoodresearch.org/...\nhttps://arxiv.org/abs/...`}
                className="w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-2 font-mono-meta text-xs focus:border-[var(--ink-primary)] focus:outline-none"
              />
            </div>

            <div className="flex flex-col">
              <label className="mb-1 block text-xs font-semibold text-[var(--ink-primary)]">
                Pasted notes, transcript, or uploaded .md / .txt files
              </label>
              <textarea
                rows={3}
                value={rawNotes}
                onChange={(e) => setRawNotes(e.target.value)}
                placeholder="Paste excerpts, interview notes, or a rough write-up…"
                className="w-full flex-1 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-2 text-xs focus:border-[var(--ink-primary)] focus:outline-none"
              />

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)]">
                  <Upload className="h-3.5 w-3.5" />
                  Upload .md / .txt
                  <input
                    type="file"
                    multiple
                    accept=".md,.txt,text/markdown,text/plain"
                    onChange={(e) => handleFiles(e.target.files)}
                    className="hidden"
                  />
                </label>
                {uploadedFiles.map((f, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-subtle)] px-2.5 py-1 text-[11px] font-medium"
                  >
                    <FileText className="h-3 w-3 text-[var(--ink-muted)]" />
                    {f.name}
                    <button
                      type="button"
                      onClick={() => setUploadedFiles((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-[var(--ink-muted)] hover:text-rose-700"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {error && <p className="text-xs font-medium text-rose-700">{error}</p>}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-3">
            <span className="text-[11px] text-[var(--ink-muted)]">
              Pulls claims and quotes from your sources so you can pick what to load.
            </span>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--ink-primary)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {loading ? 'Reading documents…' : 'Extract Draft →'}
            </button>
          </div>
        </form>
      ) : (
        /* Quote-Locked Review Step */
        <div className="mt-4 space-y-4">
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono-meta text-[10px] font-semibold uppercase text-[var(--ink-muted)]">
                Extracted Summary · {draft.docs_processed} source(s) ·{' '}
                {draft.used_llm ? `${draft.provider} · ${draft.model}` : 'keyword matching only'}
              </span>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="text-xs font-semibold text-[var(--ink-secondary)] underline"
              >
                ← Change sources
              </button>
            </div>
            <p className="mt-1 text-sm font-medium text-[var(--ink-primary)]">{draft.summary}</p>
            {draft.used_llm && <p className="mt-1 text-[11px] text-[var(--ink-muted)]">{draft.note}</p>}
          </div>

          {!draft.used_llm && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              <strong>These are rough guesses, not a reading of your text.</strong> No AI model is set up, so the
              claims below were matched by keyword from claims other people already use. Nothing is selected. Tick
              only the ones you actually hold.
            </div>
          )}

          <div className="grid max-h-[340px] gap-2 overflow-y-auto sm:grid-cols-2">
            {draft.nodes.map((node) => {
              const checked = selectedNodeIds.has(node.local_id);
              const { title, isNew } = resolveTitle(node.concept_id);
              const quote = node.citations[0]?.quote;
              return (
                <button
                  key={node.local_id}
                  type="button"
                  onClick={() => toggleNode(node.local_id)}
                  className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition ${
                    checked
                      ? 'border-[var(--ink-primary)] bg-[var(--bg-surface)]'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-canvas)] opacity-50'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      checked ? 'border-[var(--ink-primary)] bg-[var(--ink-primary)] text-white' : 'border-[var(--border-strong)]'
                    }`}
                  >
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono-meta text-[9px] font-bold uppercase text-[var(--ink-muted)]">
                        {node.stage}
                      </span>
                      {node.stance === 'rejected' && (
                        <span className="rounded-full bg-rose-50 px-1.5 py-0.5 font-mono-meta text-[9px] font-semibold text-rose-800">
                          Rejected
                        </span>
                      )}
                      {node.credence && (
                        <span className="rounded-full bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-meta text-[9px] font-semibold">
                          {credencePill(node.credence)}
                        </span>
                      )}
                      {isNew && (
                        <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 font-mono-meta text-[9px] font-semibold text-indigo-800">
                          New
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs font-bold text-[var(--ink-primary)]">{title}</div>
                    {quote && (
                      <p className="mt-1 flex items-start gap-1 text-[11px] italic text-[var(--ink-secondary)]">
                        <Quote className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                        <span className="line-clamp-2">"{quote}"</span>
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {error && <p className="text-xs font-medium text-rose-700">{error}</p>}

          <div className="flex items-center justify-between border-t border-[var(--border-hairline)] pt-3">
            <span className="text-xs text-[var(--ink-secondary)]">
              {selectedNodeIds.size} of {draft.nodes.length} claims selected
            </span>
            {existingNodeCount > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={applying || selectedNodeIds.size === 0}
                  onClick={() => handleApply('replace')}
                  className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-2 text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] disabled:opacity-40"
                >
                  Replace my map
                </button>
                <button
                  type="button"
                  disabled={applying || selectedNodeIds.size === 0}
                  onClick={() => handleApply('add')}
                  className="rounded-xl bg-[var(--ink-primary)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
                >
                  {applying ? 'Loading…' : `Add ${selectedNodeIds.size} Claims to my map →`}
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={applying || selectedNodeIds.size === 0}
                onClick={() => handleApply('replace')}
                className="rounded-xl bg-[var(--ink-primary)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
              >
                {applying ? 'Loading…' : `Load ${selectedNodeIds.size} Claims into Editor →`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
