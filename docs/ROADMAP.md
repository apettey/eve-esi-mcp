# Roadmap and known gaps

Notes on work that has been identified but not done yet. Remove an entry once it ships.

## In progress

### Load ammo from cargo before calculating engine stats

Engine stats from eve-fit (`stats` in `fitting_get`, `ship_fitting`, `fitting_analyze`) show 0 weapon DPS when guns and
launchers have no charge loaded. In-game saved fittings always store ammo in cargo rather than per slot, and ships in
assets often have empty weapons, so DPS is 0 for most real fits.

Plan: for the EFT sent to eve-fit only, load each turret and launcher that has no charge with a compatible charge
from the fit's cargo. A charge is compatible when it matches the module's charge groups (attributes 604, 605, 606,
609, 610) and charge size (attribute 128). Prefer the cargo stack with the largest quantity. Report the assumed charges
in `stats` (for example `assumed_charges`), and don't change the displayed slots or EFT. When nothing compatible is in
cargo, leave the slot empty and say so.

## Not yet tested live

- `ui_action` (set destination, waypoints, open windows) needs the character to be online in the game client.
- `mail_send` has only been tested on its error path (unknown recipients); no mail has actually been sent.
