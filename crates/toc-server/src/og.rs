use std::collections::HashMap;
use std::sync::OnceLock;

use anyhow::{anyhow, Result};
use resvg::tiny_skia::Pixmap;
use resvg::usvg::{self, fontdb, Options, Tree};
use toc_core::*;

fn shared_fontdb() -> &'static fontdb::Database {
    static DB: OnceLock<fontdb::Database> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();

        let families: Vec<String> = db
            .faces()
            .filter_map(|f| f.families.first().map(|(name, _)| name.clone()))
            .collect();

        let pick = |candidates: &[&str]| -> Option<String> {
            for cand in candidates {
                if let Some(found) = families.iter().find(|f| f.eq_ignore_ascii_case(cand)) {
                    return Some(found.clone());
                }
            }
            families.first().cloned()
        };

        if let Some(sans) = pick(&[
            "DejaVu Sans",
            "Helvetica Neue",
            "Helvetica",
            "Liberation Sans",
            "Arial",
            "SF Pro Text",
        ]) {
            db.set_sans_serif_family(sans.clone());
            db.set_serif_family(sans);
        }
        if let Some(mono) = pick(&[
            "DejaVu Sans Mono",
            "Menlo",
            "Liberation Mono",
            "Courier New",
            "DejaVu Sans",
        ]) {
            db.set_monospace_family(mono);
        }
        db
    })
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn truncate_words(s: &str, max: usize) -> String {
    let clean = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max {
        return clean;
    }
    let cut: String = clean.chars().take(max.saturating_sub(1)).collect();
    if let Some(idx) = cut.rfind(' ') {
        if idx > max / 2 {
            return format!("{}…", cut[..idx].trim_end_matches([',', ';', ':', '-', ' ']));
        }
    }
    format!("{cut}…")
}

fn wrap_two_lines(s: &str, max_per_line: usize) -> (String, String) {
    let words: Vec<&str> = s.split_whitespace().collect();
    let mut l1 = String::new();
    let mut l2 = String::new();
    for w in words {
        if l2.is_empty() && (l1.is_empty() || l1.chars().count() + 1 + w.chars().count() <= max_per_line) {
            if !l1.is_empty() {
                l1.push(' ');
            }
            l1.push_str(w);
        } else {
            if !l2.is_empty() {
                l2.push(' ');
            }
            l2.push_str(w);
        }
    }
    (truncate_words(&l1, max_per_line), truncate_words(&l2, max_per_line))
}

fn render_svg_to_png(svg: &str) -> Result<Vec<u8>> {
    let mut opt = Options::default();
    opt.fontdb = std::sync::Arc::new(shared_fontdb().clone());
    opt.font_family = "sans-serif".into();

    let tree = Tree::from_str(svg, &opt).map_err(|e| anyhow!("svg parse failed: {e}"))?;
    let size = tree.size().to_int_size();
    let mut pixmap = Pixmap::new(size.width(), size.height())
        .ok_or_else(|| anyhow!("failed to allocate pixmap"))?;
    resvg::render(&tree, usvg::Transform::default(), &mut pixmap.as_mut());
    pixmap
        .encode_png()
        .map_err(|e| anyhow!("png encode failed: {e}"))
}

pub fn render_home_og_png(actor_count: usize, concept_count: usize) -> Result<Vec<u8>> {
    let stages = [
        ("1. PREMISE", "Transformative AI", "arrives soon", "#7C3AED"),
        ("2. BOTTLENECK", "Alignment lags", "capabilities", "#7C3AED"),
        ("3. INTERVENTION", "Global halt vs.", "race-to-the-top", "#E11D48"),
        ("4. BET", "Embedded evals", "or ban treaty", "#059669"),
        ("5. OUTCOME", "Safe transition", "or time bought", "#059669"),
    ];
    let mut cols_svg = String::new();
    for (idx, (label, l1, l2, border)) in stages.iter().enumerate() {
        let x = 56 + idx * 222;
        cols_svg.push_str(&format!(
            r##"<rect x="{x}" y="330" width="204" height="190" rx="14" fill="#F3F2EC" stroke="#B8B3A5" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="{lx}" y="358" font-size="12" font-family="monospace" font-weight="700" fill="#52525B">{label}</text>
  <rect x="{cx}" y="376" width="180" height="122" rx="12" fill="#FFFFFF" stroke="{border}" stroke-width="2.2"/>
  <text x="{tx}" y="424" font-size="16" font-weight="700" fill="#18181B">{l1}</text>
  <text x="{tx}" y="448" font-size="16" font-weight="700" fill="#18181B">{l2}</text>"##,
            lx = x + 14,
            cx = x + 12,
            tx = x + 26,
        ));
    }

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="sans-serif">
  <rect width="1200" height="630" fill="#FAF9F6"/>
  <rect x="0" y="0" width="1200" height="76" fill="#FFFFFF"/>
  <line x1="0" y1="76" x2="1200" y2="76" stroke="#E4E2DC" stroke-width="1"/>
  <text x="56" y="48" font-size="25" font-weight="700" fill="#18181B">toctracker.com</text>
  <rect x="920" y="22" width="224" height="32" rx="16" fill="#F3F2EC"/>
  <text x="942" y="43" font-size="14" font-family="monospace" font-weight="700" fill="#52525B">{actor_count} MAPS · {concept_count} CLAIMS</text>

  <text x="56" y="164" font-size="50" font-weight="700" fill="#18181B">What AI Safety actors bet on,</text>
  <text x="56" y="222" font-size="50" font-weight="700" fill="#18181B">and where they split.</text>
  <text x="56" y="274" font-size="23" fill="#52525B">Premises, bottlenecks, bets, and what would change people&apos;s minds.</text>

  {cols_svg}

  <text x="56" y="576" font-size="16" font-family="monospace" fill="#71717A">Open-source, open-data Theory of Change tracker · toctracker.com</text>
</svg>"##
    );

    render_svg_to_png(&svg)
}

/// Plain status line for share images. A community draft must say so, so a screenshot carries it.
pub(crate) const DRAFT_STATUS_TEXT: &str = "Best guess from public writing. Not yet reviewed by this person.";

fn actor_status_svg(actor: &Actor, version: i32) -> String {
    if actor.authorship_status == AuthorshipStatus::CommunityDraft {
        format!(
            r##"<rect x="590" y="20" width="554" height="34" rx="17" fill="#FFFBEB" stroke="#D97706" stroke-width="1.5"/>
  <text x="867" y="43" font-size="15" font-weight="700" fill="#92400E" text-anchor="middle">{}</text>"##,
            xml_escape(DRAFT_STATUS_TEXT)
        )
    } else {
        format!(
            r##"<text x="1000" y="44" font-size="15" font-family="monospace" fill="#52525B">v{version} · Open Data</text>"##
        )
    }
}

fn compare_draft_svg(actor_a: &Actor, actor_b: &Actor) -> String {
    let drafts: Vec<&str> = [actor_a, actor_b]
        .into_iter()
        .filter(|a| a.authorship_status == AuthorshipStatus::CommunityDraft)
        .map(|a| a.display_name.as_str())
        .collect();
    if drafts.is_empty() {
        return String::new();
    }
    let who = if drafts.len() == 2 { "Both maps are".to_string() } else { format!("{}'s map is", drafts[0]) };
    let line = format!("{who} a best guess from public writing, not yet reviewed by the person.");
    format!(
        r##"<text x="56" y="206" font-size="14" font-weight="700" fill="#92400E">{}</text>"##,
        xml_escape(&truncate_words(&line, 110))
    )
}

pub fn render_actor_og_png(
    actor: &Actor,
    snapshot: &ToCSnapshot,
    concepts: &[Concept],
) -> Result<Vec<u8>> {
    let cmap: HashMap<&str, &Concept> = concepts.iter().map(|c| (c.id.as_str(), c)).collect();

    let mut cards_svg = String::new();
    let stages = Stage::all();
    for (idx, stage) in stages.iter().enumerate() {
        let x = 56 + idx * 222;
        let label = format!("{}. {}", idx + 1, stage.label().to_uppercase());
        cards_svg.push_str(&format!(
            r##"<text x="{x}" y="250" font-size="13" font-family="monospace" fill="#52525B" font-weight="700">{label}</text>"##
        ));
        let first_node = snapshot
            .nodes
            .iter()
            .find(|n| n.stage == *stage && matches!(n.stance, NodeStance::Active | NodeStance::OpenCrux));
        if let Some(node) = first_node {
            let title = cmap
                .get(node.concept_id.as_str())
                .map(|c| c.title.as_str())
                .unwrap_or(&node.concept_id);
            let (l1, l2) = wrap_two_lines(title, 20);
            let border = if node.is_load_bearing_crux { "#D97706" } else { "#CFCBC0" };
            let badge = node
                .credence
                .as_ref()
                .map(|c| c.display_pill())
                .or_else(|| node.bet_priority.map(|p| p.label().to_string()))
                .unwrap_or_default();
            let badge_svg = if badge.is_empty() {
                String::new()
            } else {
                format!(
                    r##"<rect x="{tx}" y="370" width="112" height="28" rx="14" fill="#F3F2EC"/>
                <text x="{bx}" y="389" font-size="13" font-weight="700" fill="#3F3F46">{badge}</text>"##,
                    tx = x + 14,
                    bx = x + 26,
                    badge = xml_escape(&truncate_words(&badge, 12)),
                )
            };
            cards_svg.push_str(&format!(
                r##"<rect x="{x}" y="268" width="204" height="150" rx="12" fill="#FFFFFF" stroke="{border}" stroke-width="2"/>
                <text x="{tx}" y="308" font-size="16" font-weight="700" fill="#18181B">{t1}</text>
                <text x="{tx}" y="332" font-size="16" font-weight="700" fill="#18181B">{t2}</text>
                {badge_svg}"##,
                tx = x + 14,
                t1 = xml_escape(&l1),
                t2 = xml_escape(&l2),
            ));
        }
    }

    let uc_line = snapshot
        .update_criteria
        .first()
        .map(|u| format!("IF {} -> {}", u.trigger, u.pivot_action))
        .unwrap_or_default();

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="sans-serif">
  <rect width="1200" height="630" fill="#FAF9F6"/>
  <rect x="0" y="0" width="1200" height="72" fill="#FFFFFF"/>
  <line x1="0" y1="72" x2="1200" y2="72" stroke="#E4E2DC" stroke-width="1"/>
  <text x="56" y="46" font-size="24" font-weight="700" fill="#18181B">toctracker.com</text>
  {status}

  <text x="56" y="136" font-size="38" font-weight="700" fill="#18181B">{name}</text>
  <text x="56" y="170" font-size="18" fill="#52525B">{role}</text>
  <text x="56" y="204" font-size="19" fill="#27272A">{summary}</text>

  {cards}

  <rect x="56" y="458" width="1088" height="118" rx="14" fill="#FFFBEB" stroke="#D97706" stroke-width="1.8"/>
  <text x="80" y="492" font-size="14" font-family="monospace" font-weight="700" fill="#92400E">WHAT WOULD CHANGE THEIR MIND</text>
  <text x="80" y="532" font-size="19" font-weight="600" fill="#18181B">{uc}</text>
</svg>"##,
        status = actor_status_svg(actor, snapshot.version),
        name = xml_escape(&truncate_words(&actor.display_name, 42)),
        role = xml_escape(&truncate_words(&actor.role_or_affiliation, 74)),
        summary = xml_escape(&truncate_words(&snapshot.summary, 94)),
        cards = cards_svg,
        uc = xml_escape(&truncate_words(&uc_line, 92)),
    );

    render_svg_to_png(&svg)
}

pub fn render_compare_og_png(
    actor_a: &Actor,
    actor_b: &Actor,
    diff: &DiffResult,
) -> Result<Vec<u8>> {
    let top_crux = diff
        .top_cruxes
        .first()
        .map(|c| c.canonical_title.clone())
        .unwrap_or_else(|| "Different day-to-day bets".into());

    let detail_line = diff
        .summary
        .earliest_split
        .as_ref()
        .map(|es| es.sentence.as_str())
        .unwrap_or(&diff.summary.headline);

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="sans-serif">
  <rect width="1200" height="630" fill="#FAF9F6"/>
  <rect x="0" y="0" width="1200" height="72" fill="#FFFFFF"/>
  <line x1="0" y1="72" x2="1200" y2="72" stroke="#E4E2DC" stroke-width="1"/>
  <text x="56" y="46" font-size="24" font-weight="700" fill="#18181B">toctracker.com</text>
  <text x="936" y="44" font-size="15" font-family="monospace" font-weight="700" fill="#52525B">SIDE-BY-SIDE COMPARE</text>

  <rect x="56" y="112" width="466" height="72" rx="14" fill="#FFFFFF" stroke="#7C3AED" stroke-width="2.5"/>
  <circle cx="88" cy="148" r="9" fill="#7C3AED"/>
  <text x="110" y="157" font-size="25" font-weight="700" fill="#18181B">{name_a}</text>

  <text x="545" y="157" font-size="22" font-weight="700" fill="#71717A">vs</text>

  <rect x="596" y="112" width="548" height="72" rx="14" fill="#FFFFFF" stroke="#059669" stroke-width="2.5"/>
  <circle cx="628" cy="148" r="9" fill="#059669"/>
  <text x="650" y="157" font-size="25" font-weight="700" fill="#18181B">{name_b}</text>

  {draft_line}
  <rect x="56" y="218" width="260" height="52" rx="26" fill="#F3F2EC"/>
  <text x="86" y="251" font-size="19" font-weight="700" fill="#18181B">Both agree ({shared})</text>

  <rect x="336" y="218" width="270" height="52" rx="26" fill="#FFF1F2"/>
  <text x="366" y="251" font-size="19" font-weight="700" fill="#9F1239">Disagree ({cruxes})</text>

  <rect x="626" y="218" width="330" height="52" rx="26" fill="#FFFBEB"/>
  <text x="656" y="251" font-size="19" font-weight="700" fill="#92400E">{overlap}% Premise Overlap</text>

  <rect x="56" y="308" width="1088" height="256" rx="18" fill="#FFFFFF" stroke="#E11D48" stroke-width="2.5"/>
  <rect x="88" y="340" width="218" height="32" rx="16" fill="#FFF1F2"/>
  <text x="108" y="362" font-size="14" font-family="monospace" font-weight="700" fill="#9F1239">MAIN DISAGREEMENT</text>
  <text x="88" y="428" font-size="33" font-weight="700" fill="#18181B">{top_crux}</text>
  <text x="88" y="482" font-size="20" fill="#52525B">{detail}</text>
  <text x="88" y="534" font-size="15" font-family="monospace" fill="#71717A">Compare positions, credences &amp; update criteria at toctracker.com</text>
</svg>"##,
        draft_line = compare_draft_svg(actor_a, actor_b),
        name_a = xml_escape(&truncate_words(&actor_a.display_name, 26)),
        name_b = xml_escape(&truncate_words(&actor_b.display_name, 30)),
        shared = diff.summary.shared_ground_count,
        cruxes = diff.summary.crux_disagreement_count,
        overlap = diff.summary.premise_bottleneck_overlap_pct,
        top_crux = xml_escape(&truncate_words(&top_crux, 54)),
        detail = xml_escape(&truncate_words(detail_line, 86)),
    );

    render_svg_to_png(&svg)
}
