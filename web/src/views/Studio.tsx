import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  GitFork,
  Lightbulb,
  Link2,
  Plus,
  RotateCcw,
  Sparkles,
  Target,
  Trash2,
  Undo2,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../api/client';
import {
  STAGES,
  type ActorCard,
  type Archetype,
  type Concept,
  type Credence,
  type EdgeRelation,
  type EpistemicCheckItem,
  type LiveMatchResponse,
  type PublicUser,
  type SimilarConceptMatch,
  type SnapshotEdge,
  type SnapshotNode,
  type Stage,
  type StressTestResult,
  type StudioSuggestion,
  type UpdateCriterion,
} from '../types';
import { CredencePicker } from '../components/CredencePicker';
import { SwimlaneCanvas } from '../components/SwimlaneCanvas';
import { CreateFromDocsPanel } from '../components/CreateFromDocsPanel';

interface StudioProps {
  user: PublicUser | null;
  onOpenAuth: () => void;
  onPublished?: () => void;
}

const DEFAULT_CREDENCE: Credence = {
  mode: 'qualitative',
  band: 'high',
  percent: null,
  percent_range: null,
  numeric_rationale: null,
};

let _idCounter = 0;
function makeId(prefix: string): string {
  _idCounter += 1;
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}_${rand}`;
}

function wouldCreateCycle(
  edges: SnapshotEdge[],
  sourceLocalId: string,
  targetLocalId: string
): boolean {
  if (sourceLocalId === targetLocalId) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source_local_id) ?? [];
    list.push(e.target_local_id);
    adj.set(e.source_local_id, list);
  }
  const visited = new Set<string>();
  const stack = [targetLocalId];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr === sourceLocalId) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);
    for (const next of adj.get(curr) ?? []) {
      stack.push(next);
    }
  }
  return false;
}

interface StudioHistoryFrame {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  criteria: UpdateCriterion[];
}

interface SavedStudioDraft {
  step: 1 | 2 | 3 | 4 | 5;
  stageIdx: number;
  summary: string;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  criteria: UpdateCriterion[];
  essayMarkdown: string;
  actorHandle: string;
  actorName: string;
  actorRole: string;
  actorStance: string;
  actorContact: string;
  actorKind: 'individual' | 'organization';
  changelogNote: string;
}

function readSavedDraft(key: string): SavedStudioDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedStudioDraft;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function defaultRelationForStage(stage: Stage): EdgeRelation {
  if (stage === 'intervention') return 'mitigates';
  if (stage === 'bet') return 'depends_on';
  return 'leads_to';
}

export function Studio({ user, onOpenAuth, onPublished }: StudioProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const forkHandle = searchParams.get('fork');
  const editHandle = searchParams.get('edit');
  const claimHandle = searchParams.get('claim');
  const claimMode = searchParams.get('mode'); // 'augment' | 'wipe'
  const targetExistingHandle = claimHandle || editHandle;
  const draftStorageKey = `toc_studio_draft:v1:${
    claimHandle
      ? `claim:${claimHandle}:${claimMode ?? 'augment'}`
      : editHandle
        ? `edit:${editHandle}`
        : forkHandle
          ? `fork:${forkHandle}`
          : 'new'
  }`;

  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [stageIdx, setStageIdx] = useState(0);
  const currentStage = STAGES[stageIdx];

  // Reference catalogs
  const [archetypes, setArchetypes] = useState<Archetype[]>([]);
  const [actors, setActors] = useState<ActorCard[]>([]);
  const [conceptsMap, setConceptsMap] = useState<Record<string, Concept>>({});
  const [suggestions, setSuggestions] = useState<StudioSuggestion[]>([]);

  // Working ToC draft
  const [summary, setSummary] = useState('');
  const [nodes, setNodes] = useState<SnapshotNode[]>([]);
  const [edges, setEdges] = useState<SnapshotEdge[]>([]);
  const [criteria, setCriteria] = useState<UpdateCriterion[]>([
    {
      id: 'uc_1',
      target_local_id: null,
      trigger: '',
      timeframe: 'by Q4 2027',
      pivot_action: '',
      status: 'watching',
      evidence_urls: [],
    },
  ]);

  // Undo history + auto-save hydration state
  const [history, setHistory] = useState<StudioHistoryFrame[]>([]);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [restoredDraftNotice, setRestoredDraftNotice] = useState(false);
  const [showAllOptions, setShowAllOptions] = useState(false);
  const [showAllSkeptical, setShowAllSkeptical] = useState(false);
  const [skepticalFilter, setSkepticalFilter] = useState('');

  // Direct canvas selection states
  const [editingLocalId, setEditingLocalId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Step 1 AI Create from Documents panel
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  // Step 2 type-first combobox + credence state
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [forkParentId, setForkParentId] = useState<string | null>(null);
  const [selectedCredence, setSelectedCredence] = useState<Credence>(DEFAULT_CREDENCE);
  const [nodeSourceDraft, setNodeSourceDraft] = useState('');

  // Step 5 publish fields
  const [actorHandle, setActorHandle] = useState(targetExistingHandle ?? '');
  const [actorName, setActorName] = useState('');
  const [actorRole, setActorRole] = useState('');
  const [actorStance, setActorStance] = useState('');
  const [actorContact, setActorContact] = useState('');
  const [essayMarkdown, setEssayMarkdown] = useState('');
  const [actorKind, setActorKind] = useState<'individual' | 'organization'>('individual');
  const [changelogNote, setChangelogNote] = useState('');
  const [liveMatch, setLiveMatch] = useState<LiveMatchResponse | null>(null);
  const [lintChecks, setLintChecks] = useState<EpistemicCheckItem[]>([]);
  const [showLinter, setShowLinter] = useState(false);
  const [stressTest, setStressTest] = useState<StressTestResult | null>(null);
  const [stressLoading, setStressLoading] = useState(false);
  const [similarMatches, setSimilarMatches] = useState<SimilarConceptMatch[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Escape exits direct node editor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && editingLocalId) setEditingLocalId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingLocalId]);

  // Load initial catalogs + handle ?fork or ?claim
  useEffect(() => {
    Promise.all([api.listArchetypes(), api.listActors(), api.listConcepts()]).then(
      ([archs, acts, cpts]) => {
        setArchetypes(archs);
        setActors(acts);
        const cmap: Record<string, Concept> = {};
        for (const c of cpts) cmap[c.id] = c;
        setConceptsMap(cmap);
      }
    );
  }, []);

  // Restore any local unsaved draft first; otherwise load ?edit / ?claim / ?fork from server
  useEffect(() => {
    setDraftHydrated(false);
    setRestoredDraftNotice(false);
    const saved = readSavedDraft(draftStorageKey);
    if (saved && saved.nodes.length > 0) {
      setStep(saved.step >= 2 ? saved.step : 2);
      setStageIdx(Math.min(4, Math.max(0, saved.stageIdx || 0)));
      setSummary(saved.summary || '');
      setNodes(saved.nodes);
      setEdges(saved.edges);
      setCriteria(
        saved.criteria && saved.criteria.length > 0
          ? saved.criteria
          : [
              {
                id: 'uc_1',
                target_local_id: null,
                trigger: '',
                timeframe: 'by Q4 2027',
                pivot_action: '',
                status: 'watching',
                evidence_urls: [],
              },
            ]
      );
      setEssayMarkdown(saved.essayMarkdown || '');
      if (saved.actorHandle) setActorHandle(saved.actorHandle);
      if (saved.actorName) setActorName(saved.actorName);
      if (saved.actorRole) setActorRole(saved.actorRole);
      if (saved.actorStance) setActorStance(saved.actorStance);
      if (saved.actorContact) setActorContact(saved.actorContact);
      if (saved.actorKind) setActorKind(saved.actorKind);
      if (saved.changelogNote) setChangelogNote(saved.changelogNote);
      setRestoredDraftNotice(true);
      setDraftHydrated(true);
      return;
    }

    const loadHandle = forkHandle || (targetExistingHandle && claimMode !== 'wipe' ? targetExistingHandle : null);
    if (targetExistingHandle) {
      api
        .getActor(targetExistingHandle)
        .then((res) => {
          setActorHandle(res.actor.handle);
          setActorName(res.actor.display_name);
          setActorRole(res.actor.role_or_affiliation);
          setActorStance(res.actor.one_line_stance ?? '');
          setActorContact(res.actor.contact_preference ?? '');
          setActorKind(res.actor.kind);
          if (claimMode !== 'wipe' && res.primary_snapshot) {
            setSummary(res.primary_snapshot.summary);
            setEssayMarkdown(res.primary_snapshot.essay_markdown ?? res.actor.essay_markdown ?? '');
            setNodes(res.primary_snapshot.nodes);
            setEdges(res.primary_snapshot.edges);
            setCriteria(
              res.primary_snapshot.update_criteria.length > 0
                ? res.primary_snapshot.update_criteria
                : [
                    {
                      id: 'uc_1',
                      target_local_id: null,
                      trigger: '',
                      timeframe: 'by Q4 2027',
                      pivot_action: '',
                      status: 'watching',
                      evidence_urls: [],
                    },
                  ]
            );
            setStep(2);
          } else {
            if (res.actor.essay_markdown) setEssayMarkdown(res.actor.essay_markdown);
            setStep(claimMode === 'wipe' ? 2 : 1);
          }
        })
        .catch(() => {})
        .finally(() => setDraftHydrated(true));
    } else if (loadHandle) {
      api
        .getActor(loadHandle)
        .then((res) => {
          if (res.primary_snapshot) {
            setSummary(res.primary_snapshot.summary);
            setNodes(res.primary_snapshot.nodes);
            setEdges(res.primary_snapshot.edges);
            setCriteria(
              res.primary_snapshot.update_criteria.length > 0
                ? res.primary_snapshot.update_criteria
                : [
                    {
                      id: 'uc_1',
                      target_local_id: null,
                      trigger: '',
                      timeframe: 'by Q4 2027',
                      pivot_action: '',
                      status: 'watching',
                      evidence_urls: [],
                    },
                  ]
            );
            setStep(2);
          }
        })
        .catch(() => {})
        .finally(() => setDraftHydrated(true));
    } else {
      setDraftHydrated(true);
    }
  }, [draftStorageKey, forkHandle, targetExistingHandle, claimMode]);

  // Auto-prefill Step 5 identity fields from logged-in user when empty
  useEffect(() => {
    if (!user || targetExistingHandle) return;
    if (!actorName) setActorName(user.display_name);
    if (!actorHandle) {
      const suggested = (user.x_handle ?? user.github_handle ?? user.display_name)
        .replace(/^@/, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-|-$/g, '');
      setActorHandle(suggested);
    }
  }, [user, targetExistingHandle, actorName, actorHandle]);

  // Auto-save working draft to localStorage so OAuth redirects / refreshes never lose work
  useEffect(() => {
    if (!draftHydrated) return;
    const hasContent =
      nodes.length > 0 ||
      summary.trim().length > 0 ||
      essayMarkdown.trim().length > 0 ||
      criteria.some((c) => c.trigger.trim().length > 0 || c.pivot_action.trim().length > 0);
    const timer = setTimeout(() => {
      try {
        if (!hasContent) {
          window.localStorage.removeItem(draftStorageKey);
          return;
        }
        const payload: SavedStudioDraft = {
          step,
          stageIdx,
          summary,
          nodes,
          edges,
          criteria,
          essayMarkdown,
          actorHandle,
          actorName,
          actorRole,
          actorStance,
          actorContact,
          actorKind,
          changelogNote,
        };
        window.localStorage.setItem(draftStorageKey, JSON.stringify(payload));
      } catch {
        // ignore storage quota errors
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [
    draftHydrated,
    draftStorageKey,
    step,
    stageIdx,
    summary,
    nodes,
    edges,
    criteria,
    essayMarkdown,
    actorHandle,
    actorName,
    actorRole,
    actorStance,
    actorContact,
    actorKind,
    changelogNote,
  ]);

  // Fetch contextual suggestions whenever stage or prior nodes change
  const priorConceptIds = useMemo(() => nodes.map((n) => n.concept_id), [nodes]);
  useEffect(() => {
    api
      .studioSuggest(currentStage.key, priorConceptIds)
      .then(setSuggestions)
      .catch(() => {});
  }, [currentStage.key, priorConceptIds]);

  // Live overlap match + silent epistemic graph linter
  useEffect(() => {
    if (nodes.length === 0) {
      setLiveMatch(null);
      setLintChecks([]);
      return;
    }
    const timer = setTimeout(() => {
      api.studioLiveMatch(nodes, edges).then(setLiveMatch).catch(() => {});
      api.studioCheck(nodes, edges, criteria).then(setLintChecks).catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [nodes, edges, criteria]);

  // Near-duplicate fork nudge while typing custom node
  useEffect(() => {
    const trimmed = draftTitle.trim();
    if (trimmed.length < 8 || forkParentId) {
      setSimilarMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      api.studioSimilar(currentStage.key, trimmed).then(setSimilarMatches).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [draftTitle, currentStage.key, forkParentId]);

  async function handleRunDeepStressTest() {
    if (nodes.length === 0) return;
    setStressLoading(true);
    try {
      const res = await api.studioStressTest(nodes, edges, criteria);
      setStressTest(res);
      setShowLinter(true);
    } catch (e) {
      setAiNotice(e instanceof Error ? e.message : 'Stress-test failed');
    } finally {
      setStressLoading(false);
    }
  }

  async function addHiddenAssumptionAsPremise(title: string, why: string) {
    try {
      const created = await api.createConcept({
        stage: 'premise',
        title,
        description: why,
      });
      setConceptsMap((prev) => ({ ...prev, [created.id]: created }));
      addNodeForConcept(created, 'premise');
    } catch (e) {
      setAiNotice(e instanceof Error ? e.message : 'Could not add premise');
    }
  }

  function addSuggestedCriterion(trigger: string, timeframe: string | null | undefined, pivot: string) {
    setCriteria((prev) => {
      const hasBlank = prev.length === 1 && !prev[0].trigger.trim() && !prev[0].pivot_action.trim();
      const nextItem: UpdateCriterion = {
        id: `uc_st_${Date.now()}`,
        target_local_id: nodes.find((n) => n.is_load_bearing_crux)?.local_id ?? nodes[0]?.local_id ?? null,
        trigger,
        timeframe: timeframe ?? null,
        pivot_action: pivot,
        status: 'watching',
        evidence_urls: [],
      };
      return hasBlank ? [nextItem] : [...prev, nextItem];
    });
    setStep(4);
  }

  function pushUndo() {
    setHistory((prev) => [...prev.slice(-24), { nodes, edges, criteria }]);
  }

  function handleUndo() {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setNodes(last.nodes);
      setEdges(last.edges);
      setCriteria(last.criteria);
      setEditingLocalId(null);
      setSelectedEdgeId(null);
      return prev.slice(0, -1);
    });
  }

  function clearSavedDraft() {
    try {
      window.localStorage.removeItem(draftStorageKey);
    } catch {
      // ignore
    }
  }

  function handleResetDraft() {
    if (nodes.length > 0 && !window.confirm('Clear your current draft and start over?')) return;
    pushUndo();
    clearSavedDraft();
    setRestoredDraftNotice(false);
    setSummary('');
    setNodes([]);
    setEdges([]);
    setCriteria([
      {
        id: makeId('uc'),
        target_local_id: null,
        trigger: '',
        timeframe: 'by Q4 2027',
        pivot_action: '',
        status: 'watching',
        evidence_urls: [],
      },
    ]);
    setEditingLocalId(null);
    setSelectedEdgeId(null);
    setStep(1);
  }

  function loadArchetype(arch: Archetype) {
    if (nodes.length > 0 && !window.confirm('Replace your current map with this template? (You can Undo anytime.)')) {
      return;
    }
    pushUndo();
    setSummary(arch.summary);
    setNodes(arch.nodes);
    setEdges(arch.edges);
    setCriteria(arch.update_criteria.length > 0 ? arch.update_criteria : criteria);
    setEditingLocalId(null);
    setSelectedEdgeId(null);
    setStep(2);
  }

  function addNodeForConcept(concept: Concept, stage: Stage) {
    if (!concept?.id) return;
    const needsCredence = stage === 'premise' || stage === 'bottleneck' || stage === 'intervention';
    if (
      needsCredence &&
      selectedCredence.mode === 'numeric' &&
      (selectedCredence.numeric_rationale ?? '').trim().length < 10
    ) {
      setAiNotice('Exact numeric % requires a brief justification (at least 10 characters).');
      return;
    }

    const existingActive = nodes.find(
      (n) => n.concept_id === concept.id && (n.stance === 'active' || n.stance === 'open_crux')
    );
    if (existingActive) {
      setEditingLocalId(existingActive.local_id);
      setAiNotice(`"${concept.title}" is already on your map — opened it for editing.`);
      return;
    }

    pushUndo();

    // If this concept was previously marked skeptical, upgrade it cleanly to active
    const existingRejected = nodes.find((n) => n.concept_id === concept.id && n.stance === 'rejected');
    const localId = existingRejected ? existingRejected.local_id : makeId(`n_${stage}`);
    const newNode: SnapshotNode = {
      local_id: localId,
      concept_id: concept.id,
      stage,
      stance: 'active',
      is_load_bearing_crux: stage === 'intervention' && !nodes.some((n) => n.is_load_bearing_crux),
      credence: needsCredence ? { ...selectedCredence } : null,
      bet_priority: stage === 'bet' ? 'primary' : null,
      note: null,
      citations: [],
    };

    // Keep graphs sparse: only auto-wire 1 arrow when there's a single node in the previous column
    // (or a single currently-selected node in the previous column) instead of dense all-to-all wiring.
    const prevStageIdx = STAGES.findIndex((s) => s.key === stage) - 1;
    const newEdges: SnapshotEdge[] = [];
    if (prevStageIdx >= 0) {
      const prevStageKey = STAGES[prevStageIdx].key;
      const prevNodes = nodes.filter(
        (n) => n.stage === prevStageKey && (n.stance === 'active' || n.stance === 'open_crux')
      );
      const selectedPrev = editingLocalId
        ? prevNodes.find((n) => n.local_id === editingLocalId)
        : undefined;
      const autoSource = selectedPrev ?? (prevNodes.length === 1 ? prevNodes[0] : undefined);
      if (autoSource) {
        const edgeExists = edges.some(
          (e) => e.source_local_id === autoSource.local_id && e.target_local_id === localId
        );
        if (!edgeExists) {
          newEdges.push({
            id: makeId('e'),
            source_local_id: autoSource.local_id,
            target_local_id: localId,
            relation: defaultRelationForStage(stage),
            note: null,
          });
        }
      }
    }

    setNodes((prev) =>
      existingRejected
        ? prev.map((n) => (n.local_id === existingRejected.local_id ? newNode : n))
        : [...prev, newNode]
    );
    if (newEdges.length > 0) setEdges((prev) => [...prev, ...newEdges]);
  }

  async function handleTypeFirstAdd(e: React.FormEvent) {
    e.preventDefault();
    const title = draftTitle.trim();
    if (!title) return;

    // If user typed an exact match to an existing concept in this stage and isn't forking, reuse it directly!
    if (!forkParentId) {
      const exactMatch = Object.values(conceptsMap).find(
        (c) => c.stage === currentStage.key && c.title.toLowerCase() === title.toLowerCase()
      );
      if (exactMatch) {
        addNodeForConcept(exactMatch, currentStage.key);
        setDraftTitle('');
        return;
      }
    }

    try {
      const created = await api.createConcept({
        stage: currentStage.key,
        title,
        description: '',
        parent_concept_id: forkParentId,
      });
      setConceptsMap((prev) => ({ ...prev, [created.id]: created }));
      addNodeForConcept(created, currentStage.key);
      setDraftTitle('');
      setForkParentId(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create node');
    }
  }

  function handleConnectNodes(sourceLocalId: string, targetLocalId: string) {
    const exists = edges.some(
      (e) => e.source_local_id === sourceLocalId && e.target_local_id === targetLocalId
    );
    if (exists) return;
    if (wouldCreateCycle(edges, sourceLocalId, targetLocalId)) {
      setAiNotice('That arrow would create a loop. Flowcharts must stay acyclic (left to right).');
      return;
    }
    pushUndo();
    const targetNode = nodes.find((n) => n.local_id === targetLocalId);
    const rel = targetNode ? defaultRelationForStage(targetNode.stage) : 'leads_to';
    const id = makeId('e');
    setEdges((prev) => [
      ...prev,
      { id, source_local_id: sourceLocalId, target_local_id: targetLocalId, relation: rel, note: null },
    ]);
    setSelectedEdgeId(id);
  }

  function handleUpdateEdgeRelation(edgeId: string, relation: EdgeRelation | null) {
    setEdges((prev) => prev.map((e) => (e.id === edgeId ? { ...e, relation } : e)));
  }

  function handleDeleteEdge(edgeId: string) {
    pushUndo();
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
  }

  function removeNode(localId: string) {
    pushUndo();
    setNodes((prev) => prev.filter((n) => n.local_id !== localId));
    setEdges((prev) => prev.filter((e) => e.source_local_id !== localId && e.target_local_id !== localId));
    if (editingLocalId === localId) setEditingLocalId(null);
  }

  function updateNode(localId: string, patch: Partial<SnapshotNode>) {
    setNodes((prev) => prev.map((n) => (n.local_id === localId ? { ...n, ...patch } : n)));
  }

  function toggleCrux(localId: string) {
    setNodes((prev) =>
      prev.map((n) => (n.local_id === localId ? { ...n, is_load_bearing_crux: !n.is_load_bearing_crux } : n))
    );
  }

  function toggleRejectedConcept(concept: Concept | undefined) {
    if (!concept?.id) return;
    const targetRoot = concept.root_concept_id || concept.id;

    // Never touch or overwrite an active node on the canvas
    const conflictActive = nodes.find((n) => {
      if (n.stance !== 'active' && n.stance !== 'open_crux') return false;
      const nRoot = conceptsMap[n.concept_id]?.root_concept_id ?? n.concept_id;
      return n.concept_id === concept.id || nRoot === targetRoot;
    });
    if (conflictActive) {
      setAiNotice(`"${concept.title}" is already active on your map — remove it from the canvas first if you want to mark it skeptical.`);
      return;
    }

    pushUndo();
    setNodes((prev) => {
      const existing = prev.find((n) => n.concept_id === concept.id && n.stance === 'rejected');
      if (existing) {
        return prev.filter((n) => n.local_id !== existing.local_id);
      }
      const newNode: SnapshotNode = {
        local_id: makeId('n_rej'),
        concept_id: concept.id,
        stage: concept.stage,
        stance: 'rejected',
        is_load_bearing_crux: false,
        credence: { mode: 'qualitative', band: 'low', percent: null, percent_range: null, numeric_rationale: null },
        bet_priority: null,
        note: 'Not betting on this path.',
        citations: [],
      };
      return [...prev, newNode];
    });
  }

  function jumpToAddInStage(stage: Stage) {
    const idx = STAGES.findIndex((s) => s.key === stage);
    if (idx >= 0) {
      setStageIdx(idx);
      setStep(2);
      setEditingLocalId(null);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }

  const validCriteriaCount = criteria.filter(
    (u) => u.trigger.trim().length > 0 && u.pivot_action.trim().length > 0
  ).length;


  function isUnpublishedConceptId(id: string) {
    // Catalog concepts (seed and server-issued) always use a `cpt_` prefix.
    // Draft extraction uses temporary ids such as `new_1` or `tmp-1`.
    return !id.startsWith('cpt_');
  }

  async function publishNewConcepts(finalNodes: SnapshotNode[]): Promise<SnapshotNode[]> {
    const tempToReal: Record<string, string> = {};
    const created: Concept[] = [];
    const stageByConcept: Record<string, SnapshotNode['stage']> = {};
    for (const node of finalNodes) {
      stageByConcept[node.concept_id] = node.stage;
    }

    async function ensureCreated(id: string): Promise<string> {
      if (!isUnpublishedConceptId(id)) return id;
      if (tempToReal[id]) return tempToReal[id];
      const local = conceptsMap[id];
      const parentId = local?.parent_concept_id ?? null;
      const parent = parentId ? await ensureCreated(parentId) : null;
      const createdConcept = await api.createConcept({
        stage: local?.stage ?? stageByConcept[id] ?? 'premise',
        title: local?.title ?? id,
        description: local?.description ?? '',
        parent_concept_id: parent,
      });
      tempToReal[id] = createdConcept.id;
      created.push(createdConcept);
      return createdConcept.id;
    }

    for (const node of finalNodes) {
      if (!isUnpublishedConceptId(node.concept_id)) continue;
      await ensureCreated(node.concept_id);
    }
    if (created.length > 0) {
      setConceptsMap((prev) => {
        const next = { ...prev };
        for (const [tempId, realId] of Object.entries(tempToReal)) {
          const local = next[tempId];
          delete next[tempId];
          const createdConcept = created.find((c) => c.id === realId);
          if (createdConcept) next[createdConcept.id] = createdConcept;
          else if (local) next[realId] = { ...local, id: realId };
        }
        return next;
      });
      setNodes((prev) =>
        prev.map((n) => ({ ...n, concept_id: tempToReal[n.concept_id] ?? n.concept_id }))
      );
    }
    return finalNodes.map((n) => ({
      ...n,
      concept_id: tempToReal[n.concept_id] ?? n.concept_id,
    }));
  }

  async function handlePublish() {
    setPublishError(null);
    const activeNodes = nodes.filter((n) => n.stance === 'active' || n.stance === 'open_crux');
    if (activeNodes.length === 0) {
      setPublishError('Add at least one active node to your flowchart before publishing.');
      return;
    }
    const missingRationaleNode = activeNodes.find(
      (n) =>
        n.credence &&
        (n.credence.mode === 'numeric' || n.credence.percent != null) &&
        (n.credence.numeric_rationale ?? '').trim().length < 10
    );
    if (missingRationaleNode) {
      const title = conceptsMap[missingRationaleNode.concept_id]?.title ?? missingRationaleNode.concept_id;
      setPublishError(
        `"${title}" uses an exact % credence and needs a short justification (10+ characters). Click it on the canvas to add one.`
      );
      setEditingLocalId(missingRationaleNode.local_id);
      return;
    }
    if (validCriteriaCount < 1) {
      setPublishError('At least one complete Update Criterion (IF + THEN) is required to publish.');
      return;
    }
    if (!user) {
      onOpenAuth();
      return;
    }
    const cleanHandle = (actorHandle || actorName)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '');
    if (cleanHandle.length < 2) {
      setPublishError('Please enter a name or handle.');
      return;
    }

    const finalNodes = nodes;
    const validIds = new Set(finalNodes.map((n) => n.local_id));
    const cleanEdges = edges.filter(
      (e) => validIds.has(e.source_local_id) && validIds.has(e.target_local_id) && e.source_local_id !== e.target_local_id
    );
    const cleanCriteria = criteria
      .filter((u) => u.trigger.trim() && u.pivot_action.trim())
      .map((u) => ({
        ...u,
        target_local_id: u.target_local_id && validIds.has(u.target_local_id) ? u.target_local_id : null,
      }));

    setPublishing(true);
    try {
      if (claimHandle) {
        await api.claimActor(claimHandle, user?.x_handle ?? undefined);
      } else {
        const exists = actors.some((a) => a.handle.toLowerCase() === cleanHandle);
        if (!exists) {
          await api.createActor({
            handle: cleanHandle,
            display_name: actorName.trim() || cleanHandle,
            kind: actorKind,
            role_or_affiliation: actorRole.trim() || 'AI Safety Researcher',
            one_line_stance: actorStance.trim() || undefined,
            contact_preference: actorContact.trim() || undefined,
            authorship_status: 'self_authored',
          });
        }
      }

      const betTitle =
        conceptsMap[finalNodes.find((n) => n.stage === 'bet')?.concept_id ?? '']?.title ?? 'AI Safety';
      const publishedNodes = await publishNewConcepts(finalNodes);

      const finalSummary = summary.trim() || `Theory of Change focusing on ${betTitle}.`;

      await api.publishSnapshot({
        actor_handle: targetExistingHandle ?? cleanHandle,
        authorship_mode: 'self_authored',
        summary: finalSummary,
        essay_markdown: essayMarkdown.trim() || undefined,
        changelog_note: changelogNote.trim() || undefined,
        nodes: publishedNodes,
        edges: cleanEdges,
        update_criteria: cleanCriteria,
      });

      clearSavedDraft();
      onPublished?.();
      navigate(`/a/${encodeURIComponent(targetExistingHandle ?? cleanHandle)}`);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }

  // Live-filtered suggestions based on what user types in the top box (all 5 columns get rich choices!)
  const { filteredSuggestions, totalStageOptions } = useMemo(() => {
    const q = draftTitle.trim().toLowerCase();
    const usedRoots = new Set(
      nodes.map((n) => conceptsMap[n.concept_id]?.root_concept_id ?? n.concept_id)
    );
    const allStageCanonicals = Object.values(conceptsMap)
      .filter(
        (c) =>
          c.stage === currentStage.key &&
          !c.parent_concept_id &&
          !priorConceptIds.includes(c.id) &&
          !usedRoots.has(c.root_concept_id) &&
          c.title.length <= 90
      )
      .sort((a, b) => {
        const rank = (c: Concept) =>
          c.id.startsWith('cpt_root_') ? 2 : c.id.startsWith('cpt_opt_') ? 1 : 0;
        return (
          rank(b) - rank(a) ||
          (b.usage_count ?? 0) - (a.usage_count ?? 0) ||
          a.title.localeCompare(b.title)
        );
      });

    if (!q) {
      // Merge server-ranked suggestions first, then fill with remaining clean canonicals for this column
      const seen = new Set<string>();
      const merged: StudioSuggestion[] = [];
      for (const s of suggestions) {
        if (!seen.has(s.concept.id) && !priorConceptIds.includes(s.concept.id)) {
          seen.add(s.concept.id);
          merged.push(s);
        }
      }
      for (const c of allStageCanonicals) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          merged.push({
            concept: c,
            usage_count: c.usage_count ?? 0,
            is_canonical: true,
            match_reason: '',
          });
        }
      }
      return {
        filteredSuggestions: showAllOptions ? merged : merged.slice(0, 10),
        totalStageOptions: merged.length,
      };
    }

    const matching = Object.values(conceptsMap)
      .filter(
        (c) =>
          c.stage === currentStage.key &&
          !priorConceptIds.includes(c.id) &&
          (c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      )
      .sort((a, b) => (b.usage_count ?? 0) - (a.usage_count ?? 0) || a.title.localeCompare(b.title))
      .slice(0, 16)
      .map((c) => ({
        concept: c,
        usage_count: c.usage_count ?? 0,
        is_canonical: !c.parent_concept_id,
        match_reason: '',
      }));
    return { filteredSuggestions: matching, totalStageOptions: matching.length };
  }, [draftTitle, suggestions, conceptsMap, currentStage.key, priorConceptIds, nodes, showAllOptions]);

  const editingNode = editingLocalId ? nodes.find((n) => n.local_id === editingLocalId) ?? null : null;
  const editingNeedsCredence =
    editingNode &&
    (editingNode.stage === 'premise' ||
      editingNode.stage === 'bottleneck' ||
      editingNode.stage === 'intervention');

  const stageNeedsCredence =
    currentStage.key === 'premise' ||
    currentStage.key === 'bottleneck' ||
    currentStage.key === 'intervention';

  const rejectedNodes = useMemo(
    () => nodes.filter((n) => n.stance === 'rejected' || n.stance === 'deprioritized'),
    [nodes]
  );

  const siblingInterventions = useMemo(() => {
    const activeRoots = new Set(
      nodes
        .filter((n) => n.stance === 'active' || n.stance === 'open_crux')
        .map((n) => conceptsMap[n.concept_id]?.root_concept_id ?? n.concept_id)
    );
    const q = skepticalFilter.trim().toLowerCase();
    return Object.values(conceptsMap)
      .filter(
        (c) =>
          c.stage === 'intervention' &&
          !c.parent_concept_id &&
          c.title.length <= 85 &&
          !activeRoots.has(c.root_concept_id) &&
          (!q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      )
      .sort((a, b) => {
        const rank = (c: Concept) =>
          c.id.startsWith('cpt_root_') ? 2 : c.id.startsWith('cpt_opt_') ? 1 : 0;
        return (
          rank(b) - rank(a) ||
          (b.usage_count ?? 0) - (a.usage_count ?? 0) ||
          a.title.localeCompare(b.title)
        );
      });
  }, [conceptsMap, nodes, skepticalFilter]);

  return (
    <main className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6">
      {/* Clean Studio Stepper Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              [1, '1. Start'],
              [2, '2. Build Map'],
              [3, '3. Crux'],
              [4, '4. Update Criterion'],
              [5, '5. Publish'],
            ] as [1 | 2 | 3 | 4 | 5, string][]
          ).map(([num, label]) => (
            <button
              key={num}
              onClick={() => setStep(num)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                step === num
                  ? 'bg-[var(--ink-primary)] text-white'
                  : step > num
                    ? 'bg-[var(--semantic-agree-bg)] text-[var(--semantic-agree-text)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--bg-subtle)]'
              }`}
            >
              {step > num ? '✓ ' : ''}
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {history.length > 0 && (
            <button
              type="button"
              onClick={handleUndo}
              title="Undo last map edit"
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)]"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo
            </button>
          )}
          {nodes.length > 0 && step >= 2 && (
            <button
              type="button"
              onClick={handleResetDraft}
              title="Clear draft and start over"
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--bg-subtle)] hover:text-rose-700"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
          {nodes.length >= 2 && step >= 2 && (
            <button
              type="button"
              onClick={() => setShowLinter((o) => !o)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                showLinter
                  ? 'border-amber-500 bg-amber-100 text-amber-950'
                  : 'border-amber-300 bg-[var(--semantic-crux-bg)] text-amber-900 hover:bg-amber-100'
              }`}
            >
              <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
              {lintChecks.length > 0
                ? `${lintChecks.length} ${lintChecks.length === 1 ? 'check' : 'checks'}`
                : 'Stress-test'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowAiPanel((o) => !o)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-600" />
            Draft from URL / Text
          </button>
        </div>
      </div>

      {/* Silent Epistemic Graph Linter + Socratic Stress-Test Tray (Opt-in, Dismissible) */}
      {showLinter && (lintChecks.length > 0 || nodes.length >= 2) && (
        <div className="mb-4 rounded-2xl border border-amber-300/90 bg-[var(--bg-surface)] p-4">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono-meta text-[11px] font-bold uppercase tracking-wider text-amber-900">
              Map Stress-Test {lintChecks.length > 0 ? `(${lintChecks.length})` : ''}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRunDeepStressTest}
                disabled={stressLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ink-primary)] bg-[var(--ink-primary)] px-2.5 py-1 text-[11px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3 text-amber-300" />
                {stressLoading ? 'Checking…' : stressTest ? 'Re-run Stress-Test' : 'Run AI Stress-Test'}
              </button>
              <button
                type="button"
                onClick={() => setShowLinter(false)}
                className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
              >
                Hide
              </button>
            </div>
          </div>
          {lintChecks.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {lintChecks.map((item) => (
              <div
                key={item.code + item.title}
                className="flex items-start justify-between gap-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-3 text-xs"
              >
                <div className="flex items-start gap-2">
                  {item.severity === 'warning' ? (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  ) : (
                    <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-600" />
                  )}
                  <div>
                    <div className="font-semibold text-[var(--ink-primary)]">{item.title}</div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--ink-secondary)]">
                      {item.detail}
                    </p>
                  </div>
                </div>
                {item.target_local_id && (
                  <button
                    type="button"
                    onClick={() => {
                      if (item.code === 'unfalsifiable_crux' || item.code === 'vague_criterion') {
                        setStep(4);
                      } else {
                        setEditingLocalId(item.target_local_id ?? null);
                        setStep(2);
                      }
                    }}
                    className="shrink-0 rounded-md border border-[var(--border-hairline)] bg-white px-2 py-1 text-[10px] font-semibold hover:bg-[var(--bg-subtle)]"
                  >
                    Fix
                  </button>
                )}
                {item.suggested_concept_id && conceptsMap[item.suggested_concept_id] && (
                  <button
                    type="button"
                    onClick={() => toggleRejectedConcept(conceptsMap[item.suggested_concept_id!])}
                    className="shrink-0 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] font-semibold text-rose-800 hover:bg-rose-100"
                  >
                    Mark skeptical
                  </button>
                )}
              </div>
            ))}
          </div>
          )}

          {stressTest && (
            <div className="mt-3 space-y-2.5 border-t border-[var(--border-hairline)] pt-3">
              <div className="flex items-center justify-between">
                <span className="font-mono-meta text-[10px] font-bold uppercase tracking-wider text-[var(--ink-muted)]">
                  Stress-Test · {stressTest.used_llm ? `${stressTest.provider} (${stressTest.model})` : 'Field Graph'}
                </span>
              </div>
              <div className="grid gap-2.5 md:grid-cols-3">
                {stressTest.hidden_assumptions.map((ha, i) => (
                  <div
                    key={i}
                    className="flex flex-col justify-between rounded-xl border border-indigo-200/80 bg-indigo-50/40 p-3 text-xs"
                  >
                    <div>
                      <span className="font-mono-meta text-[10px] font-bold uppercase text-indigo-800">
                        Hidden Assumption
                      </span>
                      <div className="mt-1 font-semibold text-[var(--ink-primary)]">{ha.title}</div>
                      <p className="mt-1 text-[11px] leading-relaxed text-[var(--ink-secondary)]">
                        {ha.why_it_matters}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => addHiddenAssumptionAsPremise(ha.title, ha.why_it_matters)}
                      className="mt-2.5 self-start rounded-md border border-indigo-300 bg-white px-2.5 py-1 text-[10px] font-semibold text-indigo-900 hover:bg-indigo-50"
                    >
                      + Add as Premise
                    </button>
                  </div>
                ))}

                {stressTest.steelman_objection && (
                  <div className="flex flex-col justify-between rounded-xl border border-rose-200/80 bg-rose-50/40 p-3 text-xs">
                    <div>
                      <span className="font-mono-meta text-[10px] font-bold uppercase text-rose-800">
                        Strongest Objection · {stressTest.steelman_objection.from_perspective}
                      </span>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-primary)]">
                        {stressTest.steelman_objection.argument}
                      </p>
                    </div>
                    {stressTest.steelman_objection.rival_handle && (
                      <Link
                        to={`/a/${stressTest.steelman_objection.rival_handle}`}
                        target="_blank"
                        className="mt-2.5 inline-block text-[10px] font-semibold text-rose-800 underline"
                      >
                        View their map →
                      </Link>
                    )}
                  </div>
                )}

                {stressTest.suggested_criterion && (
                  <div className="flex flex-col justify-between rounded-xl border border-amber-200/80 bg-amber-50/40 p-3 text-xs">
                    <div>
                      <span className="font-mono-meta text-[10px] font-bold uppercase text-amber-900">
                        Suggested Test
                      </span>
                      <p className="mt-1 text-[11px] text-[var(--ink-primary)]">
                        <strong>IF:</strong> {stressTest.suggested_criterion.trigger}
                        {stressTest.suggested_criterion.timeframe ? ` (${stressTest.suggested_criterion.timeframe})` : ''}
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--ink-secondary)]">
                        <strong>THEN:</strong> {stressTest.suggested_criterion.pivot_action}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        addSuggestedCriterion(
                          stressTest.suggested_criterion!.trigger,
                          stressTest.suggested_criterion!.timeframe,
                          stressTest.suggested_criterion!.pivot_action
                        )
                      }
                      className="mt-2.5 self-start rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[10px] font-semibold text-amber-950 hover:bg-amber-50"
                    >
                      + Add Criterion
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Multi-Document Quote-Locked Extraction Panel */}
      {showAiPanel && (
        <CreateFromDocsPanel
          conceptsMap={conceptsMap}
          existingNodeCount={nodes.length}
          onConceptsCreated={(created) => {
            setConceptsMap((prev) => {
              const next = { ...prev };
              for (const c of created) next[c.id] = c;
              return next;
            });
          }}
          onApplyDraft={(payload) => {
            pushUndo();
            if (payload.actorNameHint && !actorName) setActorName(payload.actorNameHint);
            if (payload.actorRoleHint && !actorRole) setActorRole(payload.actorRoleHint);
            if (payload.mode === 'add' && nodes.length > 0) {
              // Keep the map already in the editor. Append only claims it does not have yet,
              // and give incoming ids a suffix so they cannot collide with existing ones.
              const tag = Date.now().toString(36);
              const haveConcepts = new Set(nodes.map((n) => n.concept_id));
              const idMap: Record<string, string> = {};
              const addedNodes = payload.nodes
                .filter((n) => !haveConcepts.has(n.concept_id))
                .map((n) => {
                  idMap[n.local_id] = `${n.local_id}_${tag}`;
                  return { ...n, local_id: idMap[n.local_id] };
                });
              const addedEdges = payload.edges
                .filter((e) => idMap[e.source_local_id] && idMap[e.target_local_id])
                .map((e) => ({
                  ...e,
                  id: `${e.id}_${tag}`,
                  source_local_id: idMap[e.source_local_id],
                  target_local_id: idMap[e.target_local_id],
                }));
              const addedCriteria = payload.updateCriteria
                .filter((u) => !u.target_local_id || idMap[u.target_local_id])
                .map((u) => ({
                  ...u,
                  id: `${u.id}_${tag}`,
                  target_local_id: u.target_local_id ? idMap[u.target_local_id] : null,
                }));
              if (!summary.trim()) setSummary(payload.summary);
              setNodes((prev) => [...prev, ...addedNodes]);
              setEdges((prev) => [...prev, ...addedEdges]);
              if (addedCriteria.length > 0) setCriteria((prev) => [...prev, ...addedCriteria]);
              const skipped = payload.nodes.length - addedNodes.length;
              setAiNotice(
                `Added ${addedNodes.length} claim${addedNodes.length === 1 ? '' : 's'} to your map.` +
                  (skipped > 0 ? ` Skipped ${skipped} already in it.` : '')
              );
            } else {
              setSummary(payload.summary);
              setNodes(payload.nodes);
              setEdges(payload.edges);
              if (payload.updateCriteria.length > 0) setCriteria(payload.updateCriteria);
              setAiNotice(payload.notice);
            }
            setShowAiPanel(false);
            setEditingLocalId(null);
            setStep(2);
          }}
          onClose={() => setShowAiPanel(false)}
        />
      )}

      {restoredDraftNotice && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-2 text-xs text-emerald-950">
          <span>Restored your unsaved draft automatically.</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleResetDraft}
              className="font-semibold text-rose-700 hover:underline"
            >
              Discard draft
            </button>
            <button
              type="button"
              onClick={() => setRestoredDraftNotice(false)}
              className="text-emerald-800 hover:text-emerald-950"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {aiNotice && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-2 text-xs text-[var(--ink-secondary)]">
          <span>{aiNotice}</span>
          <button onClick={() => setAiNotice(null)} className="text-[var(--ink-muted)] hover:text-[var(--ink-primary)]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* STEP 1: INVITING START RAMP */}
      {step === 1 && (
        <section className="mx-auto max-w-4xl space-y-5">
          <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 sm:p-8">
            <h1 className="font-editorial text-3xl font-semibold text-[var(--ink-primary)]">
              New Theory of Change
            </h1>

            {/* Primary 2 fast paths */}
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                onClick={() => {
                  setStep(2);
                  setTimeout(() => inputRef.current?.focus(), 60);
                }}
                className="group flex flex-col justify-between rounded-2xl border-2 border-[var(--ink-primary)] bg-[var(--ink-primary)] p-5 text-left text-white transition hover:opacity-95"
              >
                <div className="flex items-center justify-between">
                  <span className="text-base font-bold">Blank canvas</span>
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </div>
                <p className="mt-1.5 text-xs text-zinc-300">
                  Write your own nodes, pull common claims, and connect edges directly.
                </p>
              </button>

              <button
                onClick={() => setShowAiPanel(true)}
                className="group flex flex-col justify-between rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-5 text-left transition hover:border-[var(--ink-primary)] hover:bg-[var(--bg-surface)]"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-base font-bold text-[var(--ink-primary)]">
                    <Sparkles className="h-4 w-4 text-amber-600" />
                    Draft from URL or text
                  </span>
                  <ArrowRight className="h-4 w-4 text-[var(--ink-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--ink-primary)]" />
                </div>
                <p className="mt-1.5 text-xs text-[var(--ink-secondary)]">
                  Paste a LessWrong post, org page, or rough paragraph to generate a starting map.
                </p>
              </button>
            </div>

            {/* Archetype templates */}
            <div className="mt-7 border-t border-[var(--border-hairline)] pt-5">
              <div className="text-xs font-semibold text-[var(--ink-secondary)]">
                Or start from a template and edit where you disagree:
              </div>
              <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {archetypes.map((arch) => (
                  <button
                    key={arch.id}
                    onClick={() => loadArchetype(arch)}
                    className="group rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-3.5 text-left transition hover:border-[var(--ink-primary)] hover:bg-[var(--bg-surface)]"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-[var(--ink-primary)]">{arch.name}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-[var(--ink-muted)] group-hover:text-[var(--ink-primary)]" />
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--ink-secondary)]">
                      {arch.tagline}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            {actors.length > 0 && (
              <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--border-hairline)] pt-4">
                <span className="text-xs text-[var(--ink-muted)]">Or fork an existing map:</span>
                {actors.slice(0, 6).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => {
                      if (nodes.length > 0 && !window.confirm(`Replace your current draft with a fork of ${a.display_name}?`)) {
                        return;
                      }
                      navigate(`/studio?fork=${encodeURIComponent(a.handle)}`);
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-subtle)]"
                  >
                    <GitFork className="h-3 w-3" />
                    {a.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* STEPS 2–5: CLEAN SPLIT WORKSPACE */}
      {step >= 2 && (
        <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
          {/* Left Panel */}
          <section className="flex flex-col rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
            {/* STEP 2: EITHER DIRECT NODE EDITOR (when a canvas card is clicked) OR TYPE-FIRST ADDER */}
            {step === 2 && editingNode && (
              <div className="flex flex-1 flex-col">
                <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-3">
                  <button
                    type="button"
                    onClick={() => setEditingLocalId(null)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to adding nodes
                  </button>
                  <button
                    type="button"
                    onClick={() => removeNode(editingNode.local_id)}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </div>

                <div className="mt-4">
                  <span className="font-mono-meta text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
                    Editing {editingNode.stage}
                  </span>
                  <h2 className="mt-1 text-base font-bold leading-snug text-[var(--ink-primary)]">
                    {conceptsMap[editingNode.concept_id]?.title ?? editingNode.concept_id}
                  </h2>
                </div>

                {editingNeedsCredence && (
                  <div className="mt-4">
                    <CredencePicker
                      value={editingNode.credence ?? DEFAULT_CREDENCE}
                      onChange={(next) => updateNode(editingNode.local_id, { credence: next })}
                    />
                  </div>
                )}

                <div className="mt-4 flex items-center justify-between rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3.5 py-2.5">
                  <div>
                    <div className="text-xs font-semibold text-[var(--ink-primary)]">Mark as Key Crux</div>
                    <div className="text-[11px] text-[var(--ink-muted)]">
                      If this belief flipped, my bet would change
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleCrux(editingNode.local_id)}
                    className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition ${
                      editingNode.is_load_bearing_crux
                        ? 'bg-amber-500 text-white'
                        : 'border border-[var(--border-hairline)] bg-white text-[var(--ink-secondary)]'
                    }`}
                  >
                    <Zap className="h-3 w-3" />
                    {editingNode.is_load_bearing_crux ? 'Crux' : 'Off'}
                  </button>
                </div>

                <div className="mt-4">
                  <label className="mb-1 block text-xs font-semibold text-[var(--ink-secondary)]">
                    Brief note (optional)
                  </label>
                  <textarea
                    rows={2}
                    value={editingNode.note ?? ''}
                    onChange={(e) => updateNode(editingNode.local_id, { note: e.target.value || null })}
                    placeholder="Add a short note…"
                    className="w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-2 text-xs focus:border-[var(--ink-primary)] focus:outline-none"
                  />
                </div>

                <div className="mt-4">
                  <label className="mb-1 block text-xs font-semibold text-[var(--ink-secondary)]">
                    Supporting links (optional)
                  </label>
                  {editingNode.citations.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {editingNode.citations.map((cit, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-subtle)] px-2.5 py-0.5 text-[11px]"
                        >
                          <Link2 className="h-3 w-3 text-[var(--ink-muted)]" />
                          <span className="max-w-[160px] truncate">{cit.label}</span>
                          <button
                            type="button"
                            onClick={() =>
                              updateNode(editingNode.local_id, {
                                citations: editingNode.citations.filter((_, idx) => idx !== i),
                              })
                            }
                            className="text-[var(--ink-muted)] hover:text-rose-700"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <input
                      type="url"
                      value={nodeSourceDraft}
                      onChange={(e) => setNodeSourceDraft(e.target.value)}
                      placeholder="https://lesswrong.com/... or paper link"
                      className="flex-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs focus:border-[var(--ink-primary)] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const url = nodeSourceDraft.trim();
                        if (!url) return;
                        let label = 'Source';
                        try {
                          label = new URL(url).hostname.replace('www.', '');
                        } catch {
                          // fallback
                        }
                        updateNode(editingNode.local_id, {
                          citations: [...editingNode.citations, { label, url, quote: null }],
                        });
                        setNodeSourceDraft('');
                      }}
                      className="rounded-lg border border-[var(--border-hairline)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--bg-subtle)]"
                    >
                      Add
                    </button>
                  </div>
                </div>

                {/* Connections / Arrows editor for this node */}
                {(() => {
                  const nodeEdges = edges.filter(
                    (e) => e.source_local_id === editingNode.local_id || e.target_local_id === editingNode.local_id
                  );
                  const stageOrder = (st: Stage) => STAGES.findIndex((s) => s.key === st);
                  const curStageIdx = stageOrder(editingNode.stage);
                  const connectTargets = nodes
                    .filter(
                      (n) =>
                        n.local_id !== editingNode.local_id &&
                        (n.stance === 'active' || n.stance === 'open_crux') &&
                        !edges.some(
                          (e) => e.source_local_id === editingNode.local_id && e.target_local_id === n.local_id
                        )
                    )
                    .sort((a, b) => {
                      const aNext = stageOrder(a.stage) === curStageIdx + 1 ? 0 : stageOrder(a.stage) > curStageIdx ? 1 : 2;
                      const bNext = stageOrder(b.stage) === curStageIdx + 1 ? 0 : stageOrder(b.stage) > curStageIdx ? 1 : 2;
                      return aNext - bNext || stageOrder(a.stage) - stageOrder(b.stage);
                    });

                  return (
                    <div className="mt-4 border-t border-[var(--border-hairline)] pt-3.5">
                      <div className="mb-1.5 flex items-center justify-between">
                        <label className="text-xs font-semibold text-[var(--ink-secondary)]">
                          Arrows ({nodeEdges.length})
                        </label>
                        {nodeEdges.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              pushUndo();
                              setEdges((prev) =>
                                prev.filter(
                                  (e) =>
                                    e.source_local_id !== editingNode.local_id &&
                                    e.target_local_id !== editingNode.local_id
                                )
                              );
                            }}
                            className="text-[10px] font-semibold text-rose-700 hover:underline"
                          >
                            Disconnect all
                          </button>
                        )}
                      </div>

                      {nodeEdges.length === 0 ? (
                        <p className="text-[11px] text-[var(--ink-muted)]">
                          No arrows attached. Pick a node below or drag between dots on the canvas.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {nodeEdges.map((edge) => {
                            const isOutgoing = edge.source_local_id === editingNode.local_id;
                            const otherId = isOutgoing ? edge.target_local_id : edge.source_local_id;
                            const otherNode = nodes.find((n) => n.local_id === otherId);
                            const otherTitle = otherNode
                              ? conceptsMap[otherNode.concept_id]?.title ?? otherNode.concept_id
                              : otherId;
                            return (
                              <div
                                key={edge.id}
                                className="flex items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[11px]"
                              >
                                <span className="shrink-0 font-mono-meta text-[10px] text-[var(--ink-muted)]">
                                  {isOutgoing ? '→' : '←'}
                                </span>
                                <span className="min-w-0 flex-1 truncate font-medium text-[var(--ink-primary)]" title={otherTitle}>
                                  {otherTitle}
                                </span>
                                <select
                                  value={edge.relation ?? ''}
                                  onChange={(e) =>
                                    handleUpdateEdgeRelation(
                                      edge.id,
                                      (e.target.value || null) as EdgeRelation | null
                                    )
                                  }
                                  className="rounded border border-[var(--border-hairline)] bg-white px-1.5 py-0.5 font-mono-meta text-[10px] text-[var(--ink-secondary)]"
                                >
                                  <option value="leads_to">leads to</option>
                                  <option value="mitigates">mitigates</option>
                                  <option value="depends_on">depends on</option>
                                  <option value="conflicts_with">conflicts with</option>
                                  <option value="">no label</option>
                                </select>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteEdge(edge.id)}
                                  title="Delete arrow"
                                  className="rounded p-0.5 text-[var(--ink-muted)] hover:bg-rose-50 hover:text-rose-700"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {connectTargets.length > 0 && (
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) handleConnectNodes(editingNode.local_id, e.target.value);
                          }}
                          className="mt-2 w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--ink-secondary)] focus:border-[var(--ink-primary)] focus:outline-none"
                        >
                          <option value="">+ Connect arrow to…</option>
                          {connectTargets.map((n) => (
                            <option key={n.local_id} value={n.local_id}>
                              [{n.stage}] {conceptsMap[n.concept_id]?.title ?? n.concept_id}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })()}

                <div className="mt-auto border-t border-[var(--border-hairline)] pt-4">
                  <button
                    type="button"
                    onClick={() => setEditingLocalId(null)}
                    className="w-full rounded-xl bg-[var(--ink-primary)] py-2 text-xs font-semibold text-white"
                  >
                    Done Editing Node
                  </button>
                </div>
              </div>
            )}

            {step === 2 && !editingNode && (
              <div className="flex flex-1 flex-col">
                {/* Clean 5-Stage Selector */}
                <div className="mb-4 grid grid-cols-5 gap-1 rounded-xl bg-[var(--bg-subtle)] p-1">
                  {STAGES.map((s, i) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => {
                        setStageIdx(i);
                        setDraftTitle('');
                        setForkParentId(null);
                        setShowAllOptions(false);
                      }}
                      className={`rounded-lg py-1.5 text-[10px] font-bold transition ${
                        stageIdx === i
                          ? 'bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-xs'
                          : 'text-[var(--ink-muted)] hover:text-[var(--ink-primary)]'
                      }`}
                    >
                      {s.num}. {s.label}
                    </button>
                  ))}
                </div>

                <h2 className="text-lg font-bold text-[var(--ink-primary)]">{currentStage.question}</h2>

                {/* TYPE-FIRST PROMINENT INPUT BOX (front and center!) */}
                <form onSubmit={handleTypeFirstAdd} className="mt-3">
                  {forkParentId && (
                    <div className="mb-1.5 flex items-center justify-between rounded-lg bg-[var(--actor-a-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--actor-a-text)]">
                      <span className="inline-flex items-center gap-1">
                        <GitFork className="h-3 w-3" />
                        Editing wording (linked to shared claim)
                      </span>
                      <button type="button" onClick={() => setForkParentId(null)}>
                        ×
                      </button>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      ref={inputRef}
                      type="text"
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      placeholder={`Write your own ${currentStage.label.toLowerCase()}…`}
                      className="flex-1 rounded-xl border-2 border-[var(--border-strong)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-sm text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:border-[var(--ink-primary)] focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!draftTitle.trim()}
                      className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[var(--ink-primary)] px-4 py-2.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-35"
                    >
                      <Plus className="h-4 w-4" />
                      Add
                    </button>
                  </div>

                  {/* Subtle Near-Duplicate Fork Nudge */}
                  {similarMatches.length > 0 && !forkParentId && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-[var(--actor-a-bg)]/50 px-2.5 py-1.5 text-[11px] text-[var(--actor-a-text)]">
                      <span className="truncate">
                        Similar to <strong>"{similarMatches[0].concept.title}"</strong>
                      </span>
                      <button
                        type="button"
                        onClick={() => setForkParentId(similarMatches[0].concept.id)}
                        className="shrink-0 font-semibold underline"
                      >
                        Link as fork
                      </button>
                    </div>
                  )}
                </form>

                {/* CREDENCE PICKER — Prominent right under the input! */}
                {stageNeedsCredence && (
                  <div className="mt-4">
                    <CredencePicker value={selectedCredence} onChange={setSelectedCredence} />
                  </div>
                )}

                {/* CLEAN COMMUNITY SUGGESTIONS BELOW */}
                <div className="mt-5 border-t border-[var(--border-hairline)] pt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-[var(--ink-secondary)]">
                      {draftTitle.trim()
                        ? `Matching ${currentStage.label.toLowerCase()} options (${filteredSuggestions.length})`
                        : `Or pick a ${currentStage.label.toLowerCase()} (${totalStageOptions} options)`}
                    </span>
                    <span className="text-[11px] text-[var(--ink-muted)]">Click to add</span>
                  </div>

                  {filteredSuggestions.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-[var(--border-hairline)] px-3 py-2.5 text-xs text-[var(--ink-muted)]">
                      No matches yet. Hit <strong>Add</strong> above to create yours.
                    </p>
                  ) : (
                    <>
                      <div className="max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
                        {filteredSuggestions.map((sug) => (
                          <div
                            key={sug.concept.id}
                            className="group flex items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-2 transition hover:border-[var(--ink-primary)] hover:bg-[var(--bg-surface)]"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                addNodeForConcept(sug.concept, currentStage.key);
                                setDraftTitle('');
                              }}
                              className="flex-1 text-left"
                            >
                              <div className="text-xs font-semibold text-[var(--ink-primary)]">
                                {sug.concept.title}
                              </div>
                              {sug.usage_count > 0 && (
                                <div className="mt-0.5 font-mono-meta text-[10px] text-[var(--ink-muted)]">
                                  Used by {sug.usage_count} {sug.usage_count === 1 ? 'map' : 'maps'}
                                </div>
                              )}
                            </button>
                            <button
                              type="button"
                              title="Edit wording in the box above"
                              onClick={() => {
                                setForkParentId(sug.concept.id);
                                setDraftTitle(sug.concept.title);
                                inputRef.current?.focus();
                              }}
                              className="rounded-md p-1.5 text-[var(--ink-muted)] opacity-60 hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)] hover:opacity-100"
                            >
                              <GitFork className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                      {!draftTitle.trim() && totalStageOptions > 10 && (
                        <button
                          type="button"
                          onClick={() => setShowAllOptions((v) => !v)}
                          className="mt-2 w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] py-1.5 text-[11px] font-semibold text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)]"
                        >
                          {showAllOptions
                            ? 'Show fewer'
                            : `Show all ${totalStageOptions} ${currentStage.label.toLowerCase()} options`}
                        </button>
                      )}
                    </>
                  )}
                </div>

                {/* Navigation Footer */}
                <div className="mt-auto flex items-center justify-between border-t border-[var(--border-hairline)] pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      if (stageIdx > 0) {
                        setStageIdx(stageIdx - 1);
                        setShowAllOptions(false);
                      } else {
                        setStep(1);
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)]"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (stageIdx < 4) {
                        setStageIdx(stageIdx + 1);
                        setShowAllOptions(false);
                      } else {
                        setStep(3);
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-lg bg-[var(--ink-primary)] px-4 py-1.5 text-xs font-semibold text-white"
                  >
                    {stageIdx < 4 ? `Next: ${STAGES[stageIdx + 1].label}` : 'Next: Pick Your Crux'}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* STEP 3: PIN CRUX & REJECTED PATHS */}
            {step === 3 && (
              <div className="flex flex-1 flex-col">
                <h2 className="text-lg font-bold text-[var(--ink-primary)]">
                  Which belief matters most?
                </h2>
                <p className="mt-1 text-xs text-[var(--ink-secondary)]">
                  Click the 1–2 nodes where changing your mind would change your bet:
                </p>

                <div className="mt-3 space-y-1.5">
                  {nodes
                    .filter((n) => n.stance === 'active' || n.stance === 'open_crux')
                    .map((n) => (
                      <button
                        key={n.local_id}
                        onClick={() => toggleCrux(n.local_id)}
                        className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition ${
                          n.is_load_bearing_crux
                            ? 'border-amber-400 bg-[var(--semantic-crux-bg)] font-bold text-[var(--ink-primary)]'
                            : 'border-[var(--border-hairline)] bg-[var(--bg-canvas)] text-[var(--ink-secondary)]'
                        }`}
                      >
                        <span>{conceptsMap[n.concept_id]?.title ?? n.concept_id}</span>
                        <Zap
                          className={`h-3.5 w-3.5 ${
                            n.is_load_bearing_crux ? 'text-amber-600' : 'text-zinc-300'
                          }`}
                        />
                      </button>
                    ))}
                </div>

                <div className="mt-5 border-t border-[var(--border-hairline)] pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-bold text-[var(--ink-primary)]">
                      Anything you&apos;re skeptical of? (Optional)
                    </h3>
                    {rejectedNodes.length > 0 && (
                      <span className="rounded-full bg-[var(--semantic-disagree-bg)] px-2 py-0.5 font-mono-meta text-[10px] font-semibold text-[var(--semantic-disagree-text)]">
                        {rejectedNodes.length} marked
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--ink-secondary)]">
                    Adds approaches you&apos;re not betting on below your flowchart (never removes your active nodes).
                  </p>
                  <input
                    type="text"
                    value={skepticalFilter}
                    onChange={(e) => setSkepticalFilter(e.target.value)}
                    placeholder="Filter approaches…"
                    className="mt-2 w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs focus:border-[var(--ink-primary)] focus:outline-none"
                  />
                  <div className="mt-2.5 flex max-h-[180px] flex-wrap gap-1.5 overflow-y-auto pr-1">
                    {(showAllSkeptical || skepticalFilter.trim()
                      ? siblingInterventions
                      : siblingInterventions.slice(0, 10)
                    ).map((c) => {
                      const isRej = nodes.some((n) => n.concept_id === c.id && n.stance === 'rejected');
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleRejectedConcept(c)}
                          className={`rounded-full border px-2.5 py-1 text-left text-[11px] font-medium transition ${
                            isRej
                              ? 'border-rose-400 bg-[var(--semantic-disagree-bg)] text-[var(--semantic-disagree-text)]'
                              : 'border-[var(--border-hairline)] bg-[var(--bg-canvas)] text-[var(--ink-secondary)] hover:border-rose-300'
                          }`}
                        >
                          {isRej ? '✕ ' : '+ Skeptical: '}
                          {c.title}
                        </button>
                      );
                    })}
                  </div>
                  {!skepticalFilter.trim() && siblingInterventions.length > 10 && (
                    <button
                      type="button"
                      onClick={() => setShowAllSkeptical((v) => !v)}
                      className="mt-2 text-[11px] font-semibold text-[var(--ink-secondary)] underline hover:text-[var(--ink-primary)]"
                    >
                      {showAllSkeptical ? 'Show fewer' : `Show all ${siblingInterventions.length} approaches`}
                    </button>
                  )}
                </div>

                <div className="mt-auto flex items-center justify-between border-t border-[var(--border-hairline)] pt-4">
                  <button
                    onClick={() => setStep(2)}
                    className="rounded-lg border border-[var(--border-hairline)] px-3 py-1.5 text-xs font-semibold"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => setStep(4)}
                    className="rounded-lg bg-[var(--ink-primary)] px-4 py-1.5 text-xs font-semibold text-white"
                  >
                    Next: Update Criterion →
                  </button>
                </div>
              </div>
            )}

            {/* STEP 4: REQUIRED UPDATE CRITERION */}
            {step === 4 && (
              <div className="flex flex-1 flex-col">
                <div className="flex items-center gap-1.5 font-mono-meta text-[10px] font-semibold uppercase tracking-wider text-amber-800">
                  <Target className="h-3.5 w-3.5" />
                  Required to Publish
                </div>
                <h2 className="mt-1 text-lg font-bold text-[var(--ink-primary)]">
                  What would change your mind?
                </h2>
                <p className="mt-1 text-xs text-[var(--ink-secondary)]">
                  One concrete thing that would change your bet.
                </p>

                <div className="mt-4 space-y-3 overflow-y-auto">
                  {criteria.map((uc, idx) => (
                    <div
                      key={uc.id}
                      className="space-y-2.5 rounded-xl border border-amber-300 bg-[var(--semantic-crux-bg)] p-3.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono-meta text-[10px] font-bold uppercase text-amber-900">
                          Criterion #{idx + 1}
                        </span>
                        {criteria.length > 1 && (
                          <button
                            onClick={() => setCriteria((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-[11px] text-rose-700"
                          >
                            Remove
                          </button>
                        )}
                      </div>

                      <select
                        value={uc.target_local_id ?? ''}
                        onChange={(e) =>
                          setCriteria((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, target_local_id: e.target.value || null } : item
                            )
                          )
                        }
                        className="w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs"
                      >
                        <option value="">Applies to: Overall Theory of Change</option>
                        {nodes.map((n) => (
                          <option key={n.local_id} value={n.local_id}>
                            Tests: {conceptsMap[n.concept_id]?.title ?? n.concept_id}
                          </option>
                        ))}
                      </select>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-[var(--ink-primary)]">
                          If this happens…
                        </label>
                        <textarea
                          rows={2}
                          value={uc.trigger}
                          onChange={(e) =>
                            setCriteria((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, trigger: e.target.value } : item))
                            )
                          }
                          placeholder="e.g. White-box probes fail to beat black-box monitors on 3 model-organism suites"
                          className="w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-[var(--ink-primary)]">
                          Then I'll change my mind / bet by…
                        </label>
                        <textarea
                          rows={2}
                          value={uc.pivot_action}
                          onChange={(e) =>
                            setCriteria((prev) =>
                              prev.map((item, i) =>
                                i === idx ? { ...item, pivot_action: e.target.value } : item
                              )
                            )
                          }
                          placeholder="e.g. Drop credence below 20% and pivot to AI Control"
                          className="w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs"
                        />
                      </div>

                      <input
                        type="text"
                        value={uc.timeframe ?? ''}
                        onChange={(e) =>
                          setCriteria((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, timeframe: e.target.value } : item))
                          )
                        }
                        placeholder="Optional timeframe (e.g. by Q4 2027)"
                        className="w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs"
                      />
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={() =>
                      setCriteria((prev) => [
                        ...prev,
                        {
                          id: makeId('uc'),
                          target_local_id: null,
                          trigger: '',
                          timeframe: '',
                          pivot_action: '',
                          status: 'watching',
                          evidence_urls: [],
                        },
                      ])
                    }
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add another criterion
                  </button>
                </div>

                <div className="mt-auto flex items-center justify-between border-t border-[var(--border-hairline)] pt-4">
                  <button
                    onClick={() => setStep(3)}
                    className="rounded-lg border border-[var(--border-hairline)] px-3 py-1.5 text-xs font-semibold"
                  >
                    ← Back
                  </button>
                  <button
                    disabled={validCriteriaCount < 1}
                    onClick={() => setStep(5)}
                    className="rounded-lg bg-[var(--ink-primary)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    Preview & Publish →
                  </button>
                </div>
              </div>
            )}

            {/* STEP 5: PUBLISH */}
            {step === 5 && (
              <div className="flex flex-1 flex-col">
                <h2 className="text-lg font-bold text-[var(--ink-primary)]">
                  {claimHandle
                    ? `Publish Claimed Map (@${claimHandle})`
                    : editHandle
                      ? `Update Map (@${editHandle})`
                      : 'Publish'}
                </h2>

                {liveMatch?.closest_actor_name && (
                  <div className="mt-3 rounded-xl border border-emerald-200 bg-[var(--semantic-agree-bg)] p-3 text-xs text-[var(--semantic-agree-text)]">
                    <strong>Closest match:</strong> {liveMatch.closest_actor_name} ({liveMatch.overlap_pct}% shared premises)
                    {liveMatch.sharpest_divergence_crux && (
                      <>
                        {' '}
                        · biggest difference vs <strong>{liveMatch.sharpest_divergence_actor}</strong> on{' '}
                        <em>"{liveMatch.sharpest_divergence_crux}"</em>.
                      </>
                    )}
                  </div>
                )}

                <div className="mt-4 space-y-2.5">
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                      1-sentence summary
                    </label>
                    <textarea
                      rows={2}
                      value={summary}
                      onChange={(e) => setSummary(e.target.value)}
                      placeholder="One-sentence thesis."
                      className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs"
                    />
                  </div>

                  {!targetExistingHandle && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                            Display Name
                          </label>
                          <input
                            type="text"
                            value={actorName}
                            onChange={(e) => setActorName(e.target.value)}
                            placeholder={user?.display_name ?? 'Your Name or Org'}
                            className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                            Handle
                          </label>
                          <input
                            type="text"
                            value={actorHandle}
                            onChange={(e) => setActorHandle(e.target.value)}
                            placeholder="your-handle"
                            className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-meta text-xs"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                            Role / Affiliation
                          </label>
                          <input
                            type="text"
                            value={actorRole}
                            onChange={(e) => setActorRole(e.target.value)}
                            placeholder="Alignment Researcher"
                            className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                            Type
                          </label>
                          <select
                            value={actorKind}
                            onChange={(e) => setActorKind(e.target.value as 'individual' | 'organization')}
                            className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs"
                          >
                            <option value="individual">Individual</option>
                            <option value="organization">Organization</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                          One-line stance (optional)
                        </label>
                        <input
                          type="text"
                          value={actorStance}
                          onChange={(e) => setActorStance(e.target.value)}
                          placeholder="e.g. Containment protocols beat relying on perfect alignment."
                          className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                          Contact preferences (optional)
                        </label>
                        <input
                          type="text"
                          value={actorContact}
                          onChange={(e) => setActorContact(e.target.value)}
                          placeholder="e.g. DM on X for crux debates; open to eval collabs"
                          className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs"
                        />
                      </div>
                    </>
                  )}

                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                      Written position (optional, Markdown)
                    </label>
                    <textarea
                      rows={4}
                      value={essayMarkdown}
                      onChange={(e) => setEssayMarkdown(e.target.value)}
                      placeholder="Write out the longer version, caveats, or links in Markdown..."
                      className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-meta text-xs"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-[var(--ink-secondary)]">
                      Version note (optional)
                    </label>
                    <input
                      type="text"
                      value={changelogNote}
                      onChange={(e) => setChangelogNote(e.target.value)}
                      placeholder="Initial Theory of Change"
                      className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs"
                    />
                  </div>
                </div>

                {publishError && (
                  <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                    {publishError}
                  </p>
                )}

                <div className="mt-auto flex items-center justify-between border-t border-[var(--border-hairline)] pt-4">
                  <button
                    onClick={() => setStep(4)}
                    className="rounded-lg border border-[var(--border-hairline)] px-3 py-1.5 text-xs font-semibold"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={handlePublish}
                    disabled={publishing}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ink-primary)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {publishing ? 'Publishing…' : !user ? 'Sign in & Publish' : 'Publish'}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Right Panel: Interactive Direct-Manipulation 5-Column Flowchart */}
          <div className="space-y-3">
            <div className="relative">
              <SwimlaneCanvas
                mode="single"
                editable={true}
                activeStage={step === 2 ? currentStage.key : undefined}
                nodes={nodes}
                edges={edges}
                updateCriteria={criteria}
                concepts={conceptsMap}
                selectedLocalId={editingLocalId}
                selectedEdgeId={selectedEdgeId}
                onSelectNode={(lid) => {
                  setEditingLocalId(lid);
                  setStep(2);
                }}
                onAddInStage={jumpToAddInStage}
                onConnectNodes={handleConnectNodes}
                onSelectEdge={setSelectedEdgeId}
                onUpdateEdgeRelation={handleUpdateEdgeRelation}
                onDeleteEdge={handleDeleteEdge}
                defaultHeight={660}
              />

              {liveMatch?.closest_actor_name && liveMatch.overlap_pct > 0 && !selectedEdgeId && (
                <div className="pointer-events-none absolute bottom-4 right-4 z-10 inline-flex items-center gap-2 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface)]/95 px-3.5 py-1.5 text-xs font-medium shadow-sm backdrop-blur">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span>
                    Closest match: <strong>{liveMatch.closest_actor_name}</strong> ({liveMatch.overlap_pct}%)
                  </span>
                </div>
              )}
            </div>

            {/* Visible Skeptical / Rejected Paths Rail so marking skeptical gives immediate feedback */}
            {rejectedNodes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-3">
                <span className="text-xs font-semibold text-[var(--ink-secondary)]">
                  Skeptical / not betting on ({rejectedNodes.length}):
                </span>
                {rejectedNodes.map((rn) => {
                  const title = conceptsMap[rn.concept_id]?.title ?? rn.concept_id;
                  return (
                    <button
                      key={rn.local_id}
                      type="button"
                      onClick={() => removeNode(rn.local_id)}
                      title="Click to remove"
                      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-rose-300 bg-[var(--semantic-disagree-bg)] px-3 py-1 text-xs font-medium text-[var(--semantic-disagree-text)] transition hover:border-rose-500"
                    >
                      <span>{title}</span>
                      <X className="h-3 w-3 opacity-70" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
