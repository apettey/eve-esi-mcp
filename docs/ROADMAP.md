# Roadmap and known gaps

Notes on work that has been identified but not done yet. Remove an entry once it ships.

## Not yet tested live

- `ui_action` (set destination, waypoints, open windows) needs the character to be online in the game client.
- `mail_send` has only been tested on its error path (unknown recipients); no mail has actually been sent.

## Tools without handler tests

The tool-test harness (`src/test/harness.ts`) arrived after most tools. The tools in `UNTESTED` in
`src/test/tools.test.ts` still need handler tests, and the list may only shrink. Priorities: the write tools
(`fitting_save`, `mail_send`) and the composites the model uses most (`character_overview`, `assets`, `fitting_get`).

## Planned: planetary interaction

Research and design are in `docs/PLANETARY_INTERACTION.md`. Shipped: PI schematics in the SDE index (schema 5),
`pi_system_planets`, `pi_product` and `pi_optimize` (which also covers the planned `pi_colony_plan`: it assigns every
alt's slots). Next:

1. Extend `planets` to cover all characters by default, with projected extractor output, per-planet input/output
   balance and storage time-to-full.
2. Calibrate `pi_optimize`: read real `qty_per_cycle` from existing extractors to set `p0_per_hour_at_100` per
   character instead of the 8,000 default, and model extractor decay over the program length.
3. `pi_optimize` limits: the greedy assignment can pick a factory before the colonies that would feed it exist (a
   rebalancing pass fixes the input split afterwards, but not the choice). Link costs are a flat 6% reserve. Only
   extraction templates with two extractors are considered.
4. Verify live: whether depletion is shared between characters on one planet, and the client-only constants (CC
   levels, launchpad/storage volumes, extractor decay/cycle brackets).

## Known gaps

- Alpha/omega: ESI has no clone-state field. `character_overview` and `character_skills` infer it from training
  speed (alphas train at 50%) and from skills capped below their trained level. A character with a paused or empty
  queue and no capped skills gets no verdict.
- Skill queues are read-only in ESI, so plans (e.g. from `skill_check`) have to be pasted into the client by hand.
- Doctrine tools: saved battle reports (`br.evetools.org/br/...` and `/battle/...`, `zkillboard.com/br/...`) aren't
  read. Only related links, or system + time, are. br.evetools.org has no documented public API, so reading saved
  reports needs a documented endpoint or its maintainers' OK. Custom side assignments made on a saved report are lost
  for the same reason.
- Doctrine tools: abyssal (mutated) modules are emitted under their base type name without the mutaplasmid rolls, so
  eve-fit may value them differently from the real module.
- Doctrine tools: there is one bundle entry per hull. Different fits of the same hull (e.g. HAM and rapid-light
  Caracals) are merged by eve-fit's consensus. Splitting them into labelled variants would need a contract addition.
- Roller jump mass (`rolling` in the fitting tools) is computed from static attributes, not the fitting engine. The
  Higgs Anchor is assumed to scale the total after plates and prop modules add theirs. This hasn't been checked
  against an in-game ship or a Pyfa mass readout yet. eve-fit's `evaluate_fit` doesn't report mass; if it starts to,
  use that instead.
