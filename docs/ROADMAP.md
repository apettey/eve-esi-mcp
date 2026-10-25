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
