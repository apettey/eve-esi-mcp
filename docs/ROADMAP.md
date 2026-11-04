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
`pi_system_planets`, `pi_product`, `pi_optimize` (assigns every alt's slots; calibrates its yield from real extractors),
`pi_colony_calc` (one layout or a real colony, on the same model as the optimiser) and `planets` (all characters,
attention list, extractor output, balance, route checks, storage). Program length is modelled in both planners, and
`pi_optimize` runs a local search after its greedy pass. Next:

1. Verify live (needs the game client and running extractors; the tools can't read these from ESI): the extractor decay
   curve against in-game per-cycle bars; the cycle length and `qty_per_cycle` on 2-, 4- and 7-day programs (the
   program-length model is unverified beyond one day); the client-only constants (CC levels, launchpad/storage
   volumes); whether depletion is shared between characters on one planet. Once the new colonies run, rerun
   `pi_optimize` with the same readings so it calibrates from them.
2. `pi_optimize` limits: the local search drops one choice at a time, so it can't swap two colonies at once. Planned
   colonies use a 6% link reserve; only real colonies in `pi_colony_calc` get real link lengths. Only two-extractor
   templates are considered. Optional per-planet readings history from repeated `planets` reads to track depletion.
3. `planets`: a factory fed from storage is checked against the planet-wide balance, not against what is in storage
   for it.

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
