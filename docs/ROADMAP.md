# Roadmap and known gaps

Notes on work that has been identified but not done yet. Remove an entry once it ships.

## Not yet tested live

- `ui_action` (set destination, waypoints, open windows) needs the character to be online in the game client.
- `mail_send` has only been tested on its error path (unknown recipients); no mail has actually been sent.

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
