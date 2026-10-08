# STATUS DETAIL PHASE 3 — per 2026-10-07 22:45 +07

> Dokumen status LENGKAP Phase 3 (semantic visual storytelling). Repo:
> `C:\Users\Administrator\Documents\project\motion-video`. Phase-2 reference:
> `docs/ANALYSIS_HANDOFF_FULL.md`. Status ringkas lama digantikan dokumen ini.

---

## 1. KONDISI RUNTIME SEKARANG

| Item | Nilai |
|---|---|
| E2E `proj_p3_demo` | **COMPLETE** (run19 selesai 18:32 local; proses generate sudah mati/bersih) |
| final.mp4 / preview.mp4 | ada (1.7MB / 1.9MB) — final = render pasca repair round2 |
| QA final | `status=fail` · **overall 6.16** · confidence **0.99** · conformance **8.7** · slop **7** |
| Semantic final | relevance **5.6** · storytelling **3.7** · coverage **3.3** · **richness 10** · **subtitle coverage 10** |
| Server API+UI | hidup di `:8787` (log server bersih; tampaknya user sempat klik UI ±19:42 — novelty/semanticQa stage ke-update pasca-final, activity dari endpoint QA) |
| Tests | **91 hijau + typecheck bersih** (`npm run verify` terakhir sebelum final-run19) |
| Proses generate aktif | **tidak ada** |

### Skor per scene (median 3-judge vision, confidence)
```
scene_01: med 6.57 conf0.99 tech=pass rel6  issues4
scene_02: med 5.86 conf0.97 tech=pass rel6  issues3
scene_03: med 6.00 conf0.99 tech=FAIL rel7  issues4   ← "YES" terpotong tepi kanan frame
scene_04: med 4.29 conf0.97 tech=FAIL rel3  issues3   ← frame nyaris kosong (repair gagal utk scene ini?)
scene_05: med 6.43 conf0.99 tech=FAIL rel5  issues3
scene_06: med 6.00 conf0.99 tech=pass rel6  issues4   ← headline × ring overlap
```
Reasons utama: overall<8 · slop7 · semRel5.6 · storytelling3.7 · coverage3.3 ·
scene_02 lingkaran menyatu jadi blob + rail hilang · scene_03 YES ke-clip · scene_04 hampir
kosong (hairlines/baseline/decay line absen) · scene_05 tech-fail · scene_06 headline×ring.

---

## 2. PIPELINE AKTUAL (Phase 3)

```
SCRIPT + VO
→ script analysis (1 call) → semantic beats (1 call) → VO timing (ffprobe + phrase fallback)
→ VISUAL STORYBOARD DIRECTOR (src/agents/storyboard.ts)
    per beat: 3-5 kandidat (wajib ≥3 mekanisme beda — divalidasi di parse)
    → Art Director 13 kriteria (boleh REJECT ALL; fallback kandidat pertama bila budget habis)
    → expansion penuh → storyboardSchema (strict)
    cache: concepts/storyboard*.json + scenes/storyboard-bN.json   [RESUME-CACHED]
→ SCENE COMPOSER (src/agents/motionPlanner.ts) storyboard → scene JSON
    prompt lean ~7,5KB · reasoning_effort=none · response_format=json_object · attempts4
    wajib role+purpose utk non-text · subtitle BUKAN elemen (band system-render)
    embed scene.storyboard deterministik + inject scene.subtitle dari timestamps
    (window kumulatif clamp-duration; teks VO-verbatim; tak pernah karang timing)
    gates: Zod → validateScene (narrow≤34ch, line≤4, outward-offset, dup headline,
           subtitle timing≤duration) → collision gate (1 re-ask + soft-accept) →
           AUTO-ANCHOR fallback headline ke pita top (logged + re-validasi)
→ novelty gate (deterministik 7 dimensi termasuk mechanism)
→ RENDER preview.mp4 (bundle cache src+design+public mtime; 404→rebundle-once)
→ QA/ROUND: technical(ffprobe) · conformance(struktural+frameStats+collision model) ·
   vision 3-judge (median/mean/variance/confidence; issues call terpisah utk scene terflag) ·
   sop · SEMANTIC QA (2-judge median relevance+storytelling + coverage + subtitle + richness;
   fallback deterministik bila judge mati → source tercatat)
   → aggregateQa (reasons threshold severe + variance guard)
→ REPAIR (maks 2 round/run; best-effort per scene — gagal LLM=skip, run tetap hidup)
   plan per kategori: semantic | layout | subtitle | typography | composition
   · semantic → regenerateStoryboard(beat) → runSceneGeneration(only=[scene])  ← TERBUKTI 7×
   · lainnya → repairScene (issue/rootCause/scope/preserve + scene; gates schema/
     conceptChanged(minimal)/collision)
→ finalize: final.mp4, memory commit (dedup), manifest complete
   (complete MESKI QA fail — angka jujur tetap di qa/qa-summary.json)
```

**Resume** (`--resume`): analysis/beats/timing/storyboard/scene-valid di-skip; hanya stage
invalid + downstream yang diulang (Phase 2 §16).

---

## 3. KONTRAK DATA

```ts
Scene {
  sceneId, duration, purpose, visualConcept, composition,
  headline? {text, accentWords≤2, align, position?}      // position = anchor override
  elements Element[1..10]                                 // hard max10; guideline 3-5/5-8/7-10
  motion, timing?
  storyboard? Storyboard                                  // SEMANTIC SOURCE, embed deterministik
  subtitle? {enabled, role, phrases[{text VO-import, start, end, emphasisWords?}]}
}
Element = params registry + role(semantic|supporting|decorative) + purpose(≤140)
Storyboard = {beatId, spokenMeaning, viewerTakeaway, visualMechanism(taxonomy≤80ch),
  visualNarrative[1..8], semanticObjects[1..10{role,relationship,importance}],
  relationships[≤8], typographyPlan, subtitlePlan, motionBeats[≤10], compositionIntent,
  visualEvidence[], forbiddenInterpretations, noveltyIntent, elementBudget{min,max}}
```
- Taxonomy: `design-system/mechanisms.json` (46 mekanisme, roles, densityGuidelines)
- Primitives: 37 + **Person** + **SpeechBubble** = **39** (registry 100% konsisten dgn primitives.json)

---

## 4. QA — DIMENSI + METRIK FINAL

| Dimensi | Metode | Nilai proj_p3_demo |
|---|---|---|
| Technical | ffprobe dims/fps/codec/durasi/audio | preview/final valid; 3 scene tech-fail (vision) |
| Reference conformance | struktural + frameStats + collision model (group-flow, charW0.70 terkalibrasi) + TEXT_ONLY/GENERIC/SUBTITLE_COLLISION + density dinamis | **8.7** |
| Vision 3-judge | A(script-communication,0.2)/B(design-craft,0.4)/C(skeptic,0.6) → per-dim median + variance/confidence; issues call surgical | med scene 4.29-6.57, conf0.97-0.99 |
| Slop | 16 forbidden-pattern ids | **7** (target≤6) |
| Semantic | coverage deterministik + subtitleCoverage + richness + **2-judge median** rel/storytelling; fallback `source=deterministic-fallback` | rel5.6 · story**3.7** · cover**3.3** · rich**10** · sub**10** |
| Novelty | metaphor25/mechanism15/objects10/comp10/prims15/motion15/structure10 | accept (tidak ada reject) |
| Aggregate | mean(scene means, mean-of-means, 10−slop, conformance, semantic dims) | **6.16** (confidence0.99) |

Repair categories (plan): semantic | layout | subtitle | typography | composition +
evidence prefix COLLISION/SUBTITLE_COLLISION/TEXT_ONLY/GENERIC.
Variance guard: (rel<6|clar<6) hanya jadi reason kalo scene median<6.5.
Semantic repair gate: (rel<6 DAN storytelling<6) ATAU coverage<3.

---

## 5. E2E `proj_p3_demo` — DETAIL

- Script 61 kata (people-pleasing/"fewer yes") `e2e/p3-script.md`; VO TTS `e2e/p3-voice.wav`;
  timing source=phrase.
- **6 beat → 6 storyboard → 6 scene → preview/final**; storyboard ter-embed per scene
  (contoh scene_01: comp=leftTextRightObject, mechanism="bearing drift...",8 elemen,
  8/8 ber-role, subtitle 4 frase VO-verbatim).
- Kandidat total **30** (5/beat), unique mechanisms **21** (guard ≥3/beat lolos).
- **19 iterasi run** (`e2e/p3-run1..19.log`) — lihat §6.
- Repair round1 run19: **5 scene lewat jalur SEMANTIC** (storyboard regen → recompile):
  scene_01/02/04/05/06; round2: scene_01/02/03/04/06 (scene_05 gagal 524 → skip non-fatal).
- Repair reports di `qa/repair-*.json`; ringkasan kenapa fail ada di §1 reasons (jujur, evidence-
  based dari frame).

---

## 6. LOG BUG PHASE 3 (semua ketemu dari E2E, semua sudah di-fix)

1. `visualMechanism`/`compositionIntent`/`noveltyIntent`/`selectionRationale` kepanjangan →
   cap + limit eksplisit di prompt
2. **524 death-spiral** (retry nge-halve budget → pasti `finish_reason=length`) → dihapus;
   same-budget + backoff naik
3. **Runaway reasoning** → `reasoning_effort` (none utk composer/regen, minimal utk repair;
   provider menerima; reasoning token turun drastis — terverifikasi probe)
4. `response_format: json_object` diterima provider → dipakai semua call structured (fallback
   otomatis kalo ditolak)
5. Composer prompt dobel primitive-specs (~20KB) → lean ~7,5KB (compact bible + common inline)
6. Headline >4 baris di kolom sempit → **auto-anchor fallback** (logged+revalidasi) + normalizer
   `headline.position`
7. Subtitle-band metric dikalibrasi vs frame asli (Clock@bottom 0.40 flag; thin-line lolos)
8. Semantic 1-judge → swing ekstrem (2.8↔6.2) → **2-judge median** (5.4 stabil)
9. Semantic repair massal → gate rel DAN story / coverage<3
10. `regenerateStoryboard` mechanism kepanjangan → prompt short-label
11. headless: mime image/jpeg sniff (dulu dikirim png), VISION_UNAVAILABLE retry

---

## 7. YANG KURANG / BELUM SELESAI (jujur, terurut prioritas)

### A. Kualitas output (blokir klaim "sempurna")
1. **Overall 6.16 vs target ≥8**; storytelling **3.7** = dimensi terlemah — scene hasil regen
   masih "display, bukan demonstrate" + defect nyata:
   - scene_04 hampir KOSONG (hairlines/baseline/decay-absent — repair utk scene_04 di round1
     gagal/bermutasi?) → med 4.29, tech-fail
   - scene_03: kata "YES" raksasa **ke-clip tepi kanan** (pelanggaran safe-area by big-text —
     guard outward-offset menutup elemen kecil, bukan teks besar yang overflow)
   - scene_02: dua lingkaran menyatu jadi blob; rail Line hilang
   - scene_06: headline × ring overlap (collision soft-accept sebelumnya)
2. **Slop 7** (target ≤6) — driven oleh defect di atas.
3. **Coverage 3.3** (target≥5): token abstrak (mind/audience) tak ada di evidence — perlu
   stem/sinonim matching atau storyboard wajib evidence utk konsep abstrak.
4. **Storytelling 3.7** (target≥8): butuh iterasi composer+repair supaya mekanisme benar-benar
   tampil (elemen spec sering gak muncul di render — "labels absent", "rail missing" = compile
   gagal memunculkan objek yang storyboard janjikan). **Ini gap #1.**

### B. Belum dikerjakan
5. **Visual inspection final (§49)** — extraction frame final + checklist vision belum dilakukan
   (dilarang klaim sukses sebelum ini).
6. **Report data final §59** — belum ditulis (butuh butir5).
7. `npm run verify` ulang setelah fix terakhir (91 test terakhir hijau sebelum run19 finalize;
     pastikan lagi di akhir).
8. Docs handoff Phase3 (`ANALYSIS_HANDOFF*`) belum update metrik; MASTER_SPEC §19 sudah.
9. Resume project Phase2 lama (`proj_muwsgfuc`, `proj_ref_demo`, `proj_e2e8`) utk BEFORE/AFTER —
   belum; opsional utk bukti perbandingan.
10. RUN_E2E opt-in test belum dijalankan ulang utk Phase3.

### C. Sistemik (diketahui, ditangani sebagian)
11. Provider free-tier 524/502/429 — penyebab utama lambat; beberapa repair gagal total
    (scene_05 semantic → 524 → skip).
12. Judge variance: fallback deterministik (2.8) pernah dipakai kala judge mati → angka anjlok;
    sudah dicatat via `source` — tapi bikin noise; perlu retry judge atau 3-judge semantic.
13. Collision soft-accept ("accepted with unresolved collisions") — model kadang tetap naro
    elemen sebidang setelah re-ask; perlu mekanik deterministic "move object to other band"
    atau hard-reject di regeneration.
14. Big-text overflow safe-area (scene_03) belum dicover guard outward-offset (yang hanya
    menutup elemen kecil offset) — perlu estimasi lebar teks vs safe-area di validasi.

---

## 8. RENCANA SISA

1. Perbaiki #1/#14 (overflow teks besar + defect scene_02/04/06 via repair terarah).
2. Resume `proj_p3_demo` (stage cache) → round repair baru → sampai overall ≥8 ATAU dokumentasikan
   blocker per-scene dengan angka.
3. **Visual inspection** frame final (checklist §49) → iterate kalo jawabannya belum.
4. `npm run verify` final + `ui:build`.
5. (Opsional) resume project Phase2 utk BEFORE/AFTER.
6. Tulis **report §59** dengan angka sebenarnya (IMPLEMENTED/ARCHITECTURE/NEW AGENTS/SCHEMAS/
   SUBTITLE/QA/E2E/VISUAL INSPECTION/BEFORE-VS-AFTER/KNOWN LIMITATIONS/REMAINING BLOCKERS).

---

## 9. CATATAN PERINTAH

```bash
npm run verify                                                  # typecheck + tests
npm run generate -- --script e2e/p3-script.md --voice e2e/p3-voice.wav --id proj_p3_demo --resume
npm run serve                                                   # API+UI :8787
npm run reference:extract && npm run reference:analyze          # DNA reference (Phase 2)
```
Artefak kunci: `projects/proj_p3_demo/{concepts,scenes,qa,renders}` · log `e2e/p3-run*.log` ·
skema `src/validation/storyboardSchema.ts` · agen `src/agents/{storyboard,motionPlanner,semanticQa,repair,qa}.ts` ·
konformance `src/reference/conformance.ts` · test `tests/phase3.test.ts` (17 test Phase 3).
