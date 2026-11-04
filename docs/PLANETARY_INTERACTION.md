# Planetary Interaction (PI): research for new tools

Research notes for adding planetary interaction support to eve-esi-mcp. They cover how PI works, the full
planet → resource → product matrix, where the data comes from (SDE vs ESI vs client constants), optimisation
strategies, and a proposed set of tools.

**Data provenance.** Unless marked otherwise, every table was generated from the official SDE (build 3667080,
`planetSchematics.jsonl`, `types.jsonl`, `typeDogma.jsonl`, `mapPlanets.jsonl`, `blueprints.jsonl`), so the
implementation can derive the same data at index time instead of hard-coding it. Numbers marked **(client)** are not
in the SDE or ESI. They come from the game client and community references (EVE University wiki), and need an
in-game check before they become constants.

## 1. How PI works

| Tier | Example | Made in | Recipe shape | Cycle | Volume / unit | Tax base / unit |
|---|---|---|---|---|---|---|
| P0 (raw) | Base Metals | Extractor Control Unit (ECU) | extracted | 15 min – 4 h | 0.005 m³ | 5 ISK |
| P1 | Reactive Metals | Basic Industry Facility | 3000 P0 → 20 P1 | 30 min | 0.19 m³ | 400 ISK |
| P2 | Mechanical Parts | Advanced Industry Facility | 40 + 40 P1 → 5 P2 | 1 h | 0.75 m³ | 7,200 ISK |
| P3 | Robotics | Advanced Industry Facility | 10 + 10 (+10) P2 → 3 P3 | 1 h | 3 m³ | 60,000 ISK |
| P4 | Organic Mortar Applicators | High-Tech Production Plant | 6 + 6 + 6 P3 (or 6 + 6 P3 + 40 P1) → 1 P4 | 1 h | 50 m³ | 1,200,000 ISK |

The tax base is the SDE's `importTaxMultiplier` / `exportTaxMultiplier` (attributes 1640/1641).

- **High-Tech Production Plants exist only on Barren and Temperate planets.** These are the only two planet types
  where P4 can be made. The other factory types and the launchpad, storage and ECU exist on all 8 types.
- **The 8 colonisable planet types** are Barren, Gas, Ice, Lava, Oceanic, Plasma, Storm and Temperate. Shattered
  planets (705 in J-space, 8 in k-space) and the one "Scorched Barren" in Metropolis have no PI structures.
- **15 P0 → 15 P1 (1:1), 24 P2, 21 P3, 8 P4.** There are 68 schematics in total.
- Three P4 recipes take a P1 directly: Nano-Factory takes Reactive Metals, Organic Mortar Applicators takes Bacteria,
  and Sterile Conduits takes Water.

### Balanced factory ratios (per hour)

| Step | Consumes / h | Produces / h | Ratio for a balanced chain |
|---|---|---|---|
| Basic (P0→P1) | 6,000 P0 | 40 P1 | 1 basic per P1 input of an advanced factory |
| Advanced (P1→P2) | 40 + 40 P1 | 5 P2 | 2 basics (one per input) → 1 advanced |
| Advanced (P2→P3) | 10 + 10 (+10) P2 | 3 P3 | 2 P2 factories per P2 input → 1 P3 factory |
| High-Tech (P3→P4) | 6 + 6 + 6 P3 | 1 P4 | 2 P3 factories per P3 input → 1 P4 plant |

A fully fed P2 factory therefore needs 12,000 P0/h, about 288k per day. Most single ECUs on a highsec planet deliver a
fraction of that. This is why the usual layout splits **extraction planets** (2 ECUs plus enough basics to make P1 or
P2) from **factory planets** (launchpad plus many advanced factories that run on imported P1/P2).

### Structures (SDE dogma; per-planet-type variants are identical)

| Structure | CPU (tf) | PG (MW) | Notes |
|---|---|---|---|
| Command Center (level 0) | provides 1,675 | provides 6,000 | 500 m³ storage **(client)**, launch tax ×1.5 |
| Extractor Control Unit | 400 | 2,600 | +110 CPU / +550 PG per extra head, max 10 heads **(client)** |
| Basic Industry Facility | 200 | 800 | |
| Advanced Industry Facility | 500 | 700 | |
| High-Tech Production Plant | 1,100 | 400 | Barren / Temperate only |
| Storage Facility | 500 | 700 | 12,000 m³ **(client)** |
| Launchpad | 3,600 | 700 | 10,000 m³ **(client)**; customs transfers happen here |
| Link | 15 + 0.2·km | 10 + 0.15·km | Wiki formula **(client)**. Link upgrades raise throughput. |

Command center levels (Command Center Upgrades skill level = maximum CC level) **(client, verify)**:

| Level | Name | CPU | PG | Upgrade cost |
|---|---|---|---|---|
| 0 | Basic | 1,675 | 6,000 | — |
| 1 | Limited | 7,057 | 9,000 | 580,000 |
| 2 | Standard | 12,136 | 12,000 | 930,000 |
| 3 | Improved | 17,215 | 15,000 | 1,200,000 |
| 4 | Advanced | 21,315 | 17,000 | 1,500,000 |
| 5 | Elite | 25,415 | 19,000 | 2,100,000 |

### Skills

| Skill | Effect (SDE description) |
|---|---|
| Interplanetary Consolidation | +1 colony per level (1 + level, max 6) |
| Command Center Upgrades | Allows a higher CC level, one per skill level |
| Remote Sensing | Scan planets from 1 / 3 / 5 / 7 / 9 ly |
| Planetology / Advanced Planetology | Higher resolution on resource scans (find hotspots) |
| Customs Code Expertise | −10% of the *NPC (empire) part* of customs tax per level. Not InterBus. |

### Customs tax **(client / EVE Uni)**

- Export fee = base × rate (×1.5 when launched from the command center instead of a launchpad). Import fee =
  base × rate × 0.5.
- Highsec POCO: 10% NPC tax + owner tax, with the NPC part reduced by Customs Code Expertise. NPC customs offices
  outside highsec charge 17%. Player POCOs in low/null/J-space charge only the owner's rate, often 0–5% for friendlies.
- The tax per P0-equivalent falls as you refine. 3,000 P0 have a 15,000 ISK base; the 20 P1 made from them have a
  base of 8,000. Above P1 the base is roughly flat or rises slightly (80 P1 = 32,000 → 5 P2 = 36,000; 18 P3 =
  1.08M → 1 P4 = 1.2M). Refining **to P1 on the planet before export** is always right. Beyond that, the reasons to
  go higher are hauling volume and market price, not tax.

### Extractor output **(client formula, community reverse-engineered: verify against ESI `qty_per_cycle`)**

ESI gives `qty_per_cycle` (the base value), `cycle_time`, `head_radius`, `heads` and `install_time` /
`expiry_time`. Output decays over the program:

```
cycle_time   = from ESI (extractor_details.cycle_time)   # observed live: 15 min on one-day programs (EVE Uni's "30 min" is wrong for these)
bar_width    = cycle_time / 900 s
t            = (cycle_index + 0.5) × bar_width
decay        = base / (1 + t × 0.012)
phase        = base ^ 0.7
noise        = max((cos(phase + t/12) + cos(phase/2 + t×0.2) + cos(t×0.5)) / 3, 0)
cycle_output = floor(bar_width × decay × (1 + 0.8 × noise))
```

**Program length** (used by `pi_optimize` and `pi_colony_calc`). Per hour the curve gives 4 × `qty_per_cycle` ×
decay(t) whatever the cycle length, so at the same spot a longer program loses output per hour only to decay. The
tools assume the cycle doubles with each doubling of program length (one day: 15 min, observed; 2 days: 30 min; 3-4
days: 1 h; 5-8 days: 2 h; up to 14 days: 4 h) and that `qty_per_cycle` doesn't change with program length. That gives
one-day output per hour × 0.78 (2 days), 0.56 (4 days), 0.41 (7 days), 0.26 (14 days). **Unverified beyond one day.**
Calibration converts each real extractor from its own program length to a one-day program.

Implications: shorter programs give more P0 per hour (less decay) but need more logins. Heads that overlap
(`ecuOverlapFactor`) and depleted spots lower `qty_per_cycle`, and depletion regenerates over days. The ESI resource
heat map isn't exposed, so the tools can't pick hotspots for the player.

## 2. Planet distribution (SDE `mapPlanets`, by system security)

| Planet type | Highsec | Lowsec | Nullsec | J-space | Pochven |
|---|---|---|---|---|---|
| Barren | 3,346 | 1,669 | 8,677 | 6,101 | 66 |
| Gas | 3,145 | 1,727 | 9,099 | 6,373 | 58 |
| Temperate | 1,244 | 588 | 3,142 | 2,242 | 24 |
| Lava | 940 | 547 | 3,049 | 2,091 | 24 |
| Storm | 788 | 479 | 2,514 | 1,796 | 22 |
| Ice | 496 | 282 | 1,484 | 1,073 | 10 |
| Oceanic | 476 | 269 | 1,369 | 933 | 9 |
| Plasma | 251 | 144 | 664 | 475 | 7 |

(Security classes use rounded `securityStatus` at 0.5 and 0.0, so a few edge systems may land in a neighbouring class.)

**Scarcity drives value.** Plasma, Oceanic and Ice are rare, and in highsec only about 250 Plasma planets exist.
Three P0 occur on exactly one planet type: **Autotrophs** (Temperate), **Felsic Magma** (Lava) and **Reactive Gas**
(Gas). Every product downstream of Industrial Fibers, Silicon or Oxidizing Compound needs that planet type somewhere
in the chain.

## 3. The matrix

### P0 by planet
| Planet | P0 resources |
|---|---|
| Barren | Aqueous Liquids, Base Metals, Carbon Compounds, Microorganisms, Noble Metals |
| Gas | Aqueous Liquids, Base Metals, Ionic Solutions, Noble Gas, Reactive Gas |
| Ice | Aqueous Liquids, Heavy Metals, Microorganisms, Noble Gas, Planktic Colonies |
| Lava | Base Metals, Felsic Magma, Heavy Metals, Non-CS Crystals, Suspended Plasma |
| Oceanic | Aqueous Liquids, Carbon Compounds, Complex Organisms, Microorganisms, Planktic Colonies |
| Plasma | Base Metals, Heavy Metals, Noble Metals, Non-CS Crystals, Suspended Plasma |
| Storm | Aqueous Liquids, Base Metals, Ionic Solutions, Noble Gas, Suspended Plasma |
| Temperate | Aqueous Liquids, Autotrophs, Carbon Compounds, Complex Organisms, Microorganisms |

### P0 -> planets, and P1
| P0 | Found on | Refines to (P1) |
|---|---|---|
| Aqueous Liquids | Barren, Gas, Ice, Oceanic, Storm, Temperate | Water |
| Autotrophs | Temperate | Industrial Fibers |
| Base Metals | Barren, Gas, Lava, Plasma, Storm | Reactive Metals |
| Carbon Compounds | Barren, Oceanic, Temperate | Biofuels |
| Complex Organisms | Oceanic, Temperate | Proteins |
| Felsic Magma | Lava | Silicon |
| Heavy Metals | Ice, Lava, Plasma | Toxic Metals |
| Ionic Solutions | Gas, Storm | Electrolytes |
| Microorganisms | Barren, Ice, Oceanic, Temperate | Bacteria |
| Noble Gas | Gas, Ice, Storm | Oxygen |
| Noble Metals | Barren, Plasma | Precious Metals |
| Non-CS Crystals | Lava, Plasma | Chiral Structures |
| Planktic Colonies | Ice, Oceanic | Biomass |
| Reactive Gas | Gas | Oxidizing Compound |
| Suspended Plasma | Lava, Plasma, Storm | Plasmoids |

### Schematics

#### P1
| Output | Qty/cycle | Cycle | Inputs | Raw P0 needed | Planet types that hold all its P0 |
|---|---|---|---|---|---|
| Bacteria | 20 | 30 min | 3000x Microorganisms (P0) | Microorganisms | Barren, Ice, Oceanic, Temperate |
| Biofuels | 20 | 30 min | 3000x Carbon Compounds (P0) | Carbon Compounds | Barren, Oceanic, Temperate |
| Biomass | 20 | 30 min | 3000x Planktic Colonies (P0) | Planktic Colonies | Ice, Oceanic |
| Chiral Structures | 20 | 30 min | 3000x Non-CS Crystals (P0) | Non-CS Crystals | Lava, Plasma |
| Electrolytes | 20 | 30 min | 3000x Ionic Solutions (P0) | Ionic Solutions | Gas, Storm |
| Industrial Fibers | 20 | 30 min | 3000x Autotrophs (P0) | Autotrophs | Temperate |
| Oxidizing Compound | 20 | 30 min | 3000x Reactive Gas (P0) | Reactive Gas | Gas |
| Oxygen | 20 | 30 min | 3000x Noble Gas (P0) | Noble Gas | Gas, Ice, Storm |
| Plasmoids | 20 | 30 min | 3000x Suspended Plasma (P0) | Suspended Plasma | Lava, Plasma, Storm |
| Precious Metals | 20 | 30 min | 3000x Noble Metals (P0) | Noble Metals | Barren, Plasma |
| Proteins | 20 | 30 min | 3000x Complex Organisms (P0) | Complex Organisms | Oceanic, Temperate |
| Reactive Metals | 20 | 30 min | 3000x Base Metals (P0) | Base Metals | Barren, Gas, Lava, Plasma, Storm |
| Silicon | 20 | 30 min | 3000x Felsic Magma (P0) | Felsic Magma | Lava |
| Toxic Metals | 20 | 30 min | 3000x Heavy Metals (P0) | Heavy Metals | Ice, Lava, Plasma |
| Water | 20 | 30 min | 3000x Aqueous Liquids (P0) | Aqueous Liquids | Barren, Gas, Ice, Oceanic, Storm, Temperate |

#### P2
| Output | Qty/cycle | Cycle | Inputs | Raw P0 needed | Planet types that hold all its P0 |
|---|---|---|---|---|---|
| Biocells | 5 | 60 min | 40x Biofuels (P1), 40x Precious Metals (P1) | Carbon Compounds, Noble Metals | Barren |
| Construction Blocks | 5 | 60 min | 40x Reactive Metals (P1), 40x Toxic Metals (P1) | Base Metals, Heavy Metals | Lava, Plasma |
| Consumer Electronics | 5 | 60 min | 40x Toxic Metals (P1), 40x Chiral Structures (P1) | Heavy Metals, Non-CS Crystals | Lava, Plasma |
| Coolant | 5 | 60 min | 40x Electrolytes (P1), 40x Water (P1) | Aqueous Liquids, Ionic Solutions | Gas, Storm |
| Enriched Uranium | 5 | 60 min | 40x Precious Metals (P1), 40x Toxic Metals (P1) | Heavy Metals, Noble Metals | Plasma |
| Fertilizer | 5 | 60 min | 40x Bacteria (P1), 40x Proteins (P1) | Complex Organisms, Microorganisms | Oceanic, Temperate |
| Genetically Enhanced Livestock | 5 | 60 min | 40x Proteins (P1), 40x Biomass (P1) | Complex Organisms, Planktic Colonies | Oceanic |
| Livestock | 5 | 60 min | 40x Proteins (P1), 40x Biofuels (P1) | Carbon Compounds, Complex Organisms | Oceanic, Temperate |
| Mechanical Parts | 5 | 60 min | 40x Reactive Metals (P1), 40x Precious Metals (P1) | Base Metals, Noble Metals | Barren, Plasma |
| Microfiber Shielding | 5 | 60 min | 40x Industrial Fibers (P1), 40x Silicon (P1) | Autotrophs, Felsic Magma | — |
| Miniature Electronics | 5 | 60 min | 40x Chiral Structures (P1), 40x Silicon (P1) | Felsic Magma, Non-CS Crystals | Lava |
| Nanites | 5 | 60 min | 40x Bacteria (P1), 40x Reactive Metals (P1) | Base Metals, Microorganisms | Barren |
| Oxides | 5 | 60 min | 40x Oxidizing Compound (P1), 40x Oxygen (P1) | Noble Gas, Reactive Gas | Gas |
| Polyaramids | 5 | 60 min | 40x Oxidizing Compound (P1), 40x Industrial Fibers (P1) | Autotrophs, Reactive Gas | — |
| Polytextiles | 5 | 60 min | 40x Biofuels (P1), 40x Industrial Fibers (P1) | Autotrophs, Carbon Compounds | Temperate |
| Rocket Fuel | 5 | 60 min | 40x Plasmoids (P1), 40x Electrolytes (P1) | Ionic Solutions, Suspended Plasma | Storm |
| Silicate Glass | 5 | 60 min | 40x Oxidizing Compound (P1), 40x Silicon (P1) | Felsic Magma, Reactive Gas | — |
| Superconductors | 5 | 60 min | 40x Plasmoids (P1), 40x Water (P1) | Aqueous Liquids, Suspended Plasma | Storm |
| Supertensile Plastics | 5 | 60 min | 40x Oxygen (P1), 40x Biomass (P1) | Noble Gas, Planktic Colonies | Ice |
| Synthetic Oil | 5 | 60 min | 40x Electrolytes (P1), 40x Oxygen (P1) | Ionic Solutions, Noble Gas | Gas, Storm |
| Test Cultures | 5 | 60 min | 40x Bacteria (P1), 40x Water (P1) | Aqueous Liquids, Microorganisms | Barren, Ice, Oceanic, Temperate |
| Transmitter | 5 | 60 min | 40x Plasmoids (P1), 40x Chiral Structures (P1) | Non-CS Crystals, Suspended Plasma | Lava, Plasma |
| Viral Agent | 5 | 60 min | 40x Bacteria (P1), 40x Biomass (P1) | Microorganisms, Planktic Colonies | Ice, Oceanic |
| Water-Cooled CPU | 5 | 60 min | 40x Reactive Metals (P1), 40x Water (P1) | Aqueous Liquids, Base Metals | Barren, Gas, Storm |

#### P3
| Output | Qty/cycle | Cycle | Inputs | Raw P0 needed | Planet types that hold all its P0 |
|---|---|---|---|---|---|
| Biotech Research Reports | 3 | 60 min | 10x Nanites (P2), 10x Livestock (P2), 10x Construction Blocks (P2) | Base Metals, Carbon Compounds, Complex Organisms, Heavy Metals, Microorganisms | — |
| Camera Drones | 3 | 60 min | 10x Silicate Glass (P2), 10x Rocket Fuel (P2) | Felsic Magma, Ionic Solutions, Reactive Gas, Suspended Plasma | — |
| Condensates | 3 | 60 min | 10x Oxides (P2), 10x Coolant (P2) | Aqueous Liquids, Ionic Solutions, Noble Gas, Reactive Gas | Gas |
| Cryoprotectant Solution | 3 | 60 min | 10x Test Cultures (P2), 10x Synthetic Oil (P2), 10x Fertilizer (P2) | Aqueous Liquids, Complex Organisms, Ionic Solutions, Microorganisms, Noble Gas | — |
| Data Chips | 3 | 60 min | 10x Supertensile Plastics (P2), 10x Microfiber Shielding (P2) | Autotrophs, Felsic Magma, Noble Gas, Planktic Colonies | — |
| Gel-Matrix Biopaste | 3 | 60 min | 10x Oxides (P2), 10x Biocells (P2), 10x Superconductors (P2) | Aqueous Liquids, Carbon Compounds, Noble Gas, Noble Metals, Reactive Gas, Suspended Plasma | — |
| Guidance Systems | 3 | 60 min | 10x Water-Cooled CPU (P2), 10x Transmitter (P2) | Aqueous Liquids, Base Metals, Non-CS Crystals, Suspended Plasma | — |
| Hazmat Detection Systems | 3 | 60 min | 10x Polytextiles (P2), 10x Viral Agent (P2), 10x Transmitter (P2) | Autotrophs, Carbon Compounds, Microorganisms, Non-CS Crystals, Planktic Colonies, Suspended Plasma | — |
| Hermetic Membranes | 3 | 60 min | 10x Polyaramids (P2), 10x Genetically Enhanced Livestock (P2) | Autotrophs, Complex Organisms, Planktic Colonies, Reactive Gas | — |
| High-Tech Transmitters | 3 | 60 min | 10x Polyaramids (P2), 10x Transmitter (P2) | Autotrophs, Non-CS Crystals, Reactive Gas, Suspended Plasma | — |
| Industrial Explosives | 3 | 60 min | 10x Fertilizer (P2), 10x Polytextiles (P2) | Autotrophs, Carbon Compounds, Complex Organisms, Microorganisms | Temperate |
| Neocoms | 3 | 60 min | 10x Biocells (P2), 10x Silicate Glass (P2) | Carbon Compounds, Felsic Magma, Noble Metals, Reactive Gas | — |
| Nuclear Reactors | 3 | 60 min | 10x Enriched Uranium (P2), 10x Microfiber Shielding (P2) | Autotrophs, Felsic Magma, Heavy Metals, Noble Metals | — |
| Planetary Vehicles | 3 | 60 min | 10x Supertensile Plastics (P2), 10x Mechanical Parts (P2), 10x Miniature Electronics (P2) | Base Metals, Felsic Magma, Noble Gas, Noble Metals, Non-CS Crystals, Planktic Colonies | — |
| Robotics | 3 | 60 min | 10x Mechanical Parts (P2), 10x Consumer Electronics (P2) | Base Metals, Heavy Metals, Noble Metals, Non-CS Crystals | Plasma |
| Smartfab Units | 3 | 60 min | 10x Construction Blocks (P2), 10x Miniature Electronics (P2) | Base Metals, Felsic Magma, Heavy Metals, Non-CS Crystals | Lava |
| Supercomputers | 3 | 60 min | 10x Water-Cooled CPU (P2), 10x Coolant (P2), 10x Consumer Electronics (P2) | Aqueous Liquids, Base Metals, Heavy Metals, Ionic Solutions, Non-CS Crystals | — |
| Synthetic Synapses | 3 | 60 min | 10x Supertensile Plastics (P2), 10x Test Cultures (P2) | Aqueous Liquids, Microorganisms, Noble Gas, Planktic Colonies | Ice |
| Transcranial Microcontrollers | 3 | 60 min | 10x Biocells (P2), 10x Nanites (P2) | Base Metals, Carbon Compounds, Microorganisms, Noble Metals | Barren |
| Ukomi Superconductors | 3 | 60 min | 10x Synthetic Oil (P2), 10x Superconductors (P2) | Aqueous Liquids, Ionic Solutions, Noble Gas, Suspended Plasma | Storm |
| Vaccines | 3 | 60 min | 10x Livestock (P2), 10x Viral Agent (P2) | Carbon Compounds, Complex Organisms, Microorganisms, Planktic Colonies | Oceanic |

#### P4
| Output | Qty/cycle | Cycle | Inputs | Raw P0 needed | Planet types that hold all its P0 |
|---|---|---|---|---|---|
| Broadcast Node | 1 | 60 min | 6x Neocoms (P3), 6x Data Chips (P3), 6x High-Tech Transmitters (P3) | Autotrophs, Carbon Compounds, Felsic Magma, Noble Gas, Noble Metals, Non-CS Crystals, Planktic Colonies, Reactive Gas, Suspended Plasma | — |
| Integrity Response Drones | 1 | 60 min | 6x Gel-Matrix Biopaste (P3), 6x Hazmat Detection Systems (P3), 6x Planetary Vehicles (P3) | Aqueous Liquids, Autotrophs, Base Metals, Carbon Compounds, Felsic Magma, Microorganisms, Noble Gas, Noble Metals, Non-CS Crystals, Planktic Colonies, Reactive Gas, Suspended Plasma | — |
| Nano-Factory | 1 | 60 min | 6x Industrial Explosives (P3), 40x Reactive Metals (P1), 6x Ukomi Superconductors (P3) | Aqueous Liquids, Autotrophs, Base Metals, Carbon Compounds, Complex Organisms, Ionic Solutions, Microorganisms, Noble Gas, Suspended Plasma | — |
| Organic Mortar Applicators | 1 | 60 min | 6x Condensates (P3), 40x Bacteria (P1), 6x Robotics (P3) | Aqueous Liquids, Base Metals, Heavy Metals, Ionic Solutions, Microorganisms, Noble Gas, Noble Metals, Non-CS Crystals, Reactive Gas | — |
| Recursive Computing Module | 1 | 60 min | 6x Synthetic Synapses (P3), 6x Guidance Systems (P3), 6x Transcranial Microcontrollers (P3) | Aqueous Liquids, Base Metals, Carbon Compounds, Microorganisms, Noble Gas, Noble Metals, Non-CS Crystals, Planktic Colonies, Suspended Plasma | — |
| Self-Harmonizing Power Core | 1 | 60 min | 6x Camera Drones (P3), 6x Nuclear Reactors (P3), 6x Hermetic Membranes (P3) | Autotrophs, Complex Organisms, Felsic Magma, Heavy Metals, Ionic Solutions, Noble Metals, Planktic Colonies, Reactive Gas, Suspended Plasma | — |
| Sterile Conduits | 1 | 60 min | 6x Smartfab Units (P3), 40x Water (P1), 6x Vaccines (P3) | Aqueous Liquids, Base Metals, Carbon Compounds, Complex Organisms, Felsic Magma, Heavy Metals, Microorganisms, Non-CS Crystals, Planktic Colonies | — |
| Wetware Mainframe | 1 | 60 min | 6x Supercomputers (P3), 6x Biotech Research Reports (P3), 6x Cryoprotectant Solution (P3) | Aqueous Liquids, Base Metals, Carbon Compounds, Complex Organisms, Heavy Metals, Ionic Solutions, Microorganisms, Noble Gas, Non-CS Crystals | — |

### Smallest planet-type sets that cover all raw inputs
| Product | Tier | Min planet types | Example sets |
|---|---|---|---|
| Biocells | P2 | 1 | Barren (1 sets) |
| Construction Blocks | P2 | 1 | Lava; Plasma (2 sets) |
| Consumer Electronics | P2 | 1 | Lava; Plasma (2 sets) |
| Coolant | P2 | 1 | Gas; Storm (2 sets) |
| Enriched Uranium | P2 | 1 | Plasma (1 sets) |
| Fertilizer | P2 | 1 | Oceanic; Temperate (2 sets) |
| Genetically Enhanced Livestock | P2 | 1 | Oceanic (1 sets) |
| Livestock | P2 | 1 | Oceanic; Temperate (2 sets) |
| Mechanical Parts | P2 | 1 | Barren; Plasma (2 sets) |
| Microfiber Shielding | P2 | 2 | Lava+Temperate (1 sets) |
| Miniature Electronics | P2 | 1 | Lava (1 sets) |
| Nanites | P2 | 1 | Barren (1 sets) |
| Oxides | P2 | 1 | Gas (1 sets) |
| Polyaramids | P2 | 2 | Gas+Temperate (1 sets) |
| Polytextiles | P2 | 1 | Temperate (1 sets) |
| Rocket Fuel | P2 | 1 | Storm (1 sets) |
| Silicate Glass | P2 | 2 | Gas+Lava (1 sets) |
| Superconductors | P2 | 1 | Storm (1 sets) |
| Supertensile Plastics | P2 | 1 | Ice (1 sets) |
| Synthetic Oil | P2 | 1 | Gas; Storm (2 sets) |
| Test Cultures | P2 | 1 | Barren; Ice; Oceanic; Temperate (4 sets) |
| Transmitter | P2 | 1 | Lava; Plasma (2 sets) |
| Viral Agent | P2 | 1 | Ice; Oceanic (2 sets) |
| Water-Cooled CPU | P2 | 1 | Barren; Gas; Storm (3 sets) |
| Biotech Research Reports | P3 | 2 | Lava+Oceanic; Lava+Temperate; Oceanic+Plasma; Plasma+Temperate (4 sets) |
| Camera Drones | P3 | 2 | Gas+Lava (1 sets) |
| Condensates | P3 | 1 | Gas (1 sets) |
| Cryoprotectant Solution | P3 | 2 | Gas+Oceanic; Gas+Temperate; Oceanic+Storm; Storm+Temperate (4 sets) |
| Data Chips | P3 | 3 | Ice+Lava+Temperate (1 sets) |
| Gel-Matrix Biopaste | P3 | 3 | Barren+Gas+Lava; Barren+Gas+Plasma; Barren+Gas+Storm; Gas+Oceanic+Plasma; Gas+Plasma+Temperate (5 sets) |
| Guidance Systems | P3 | 2 | Barren+Lava; Barren+Plasma; Gas+Lava; Gas+Plasma; Ice+Lava; Ice+Plasma … (12 sets) |
| Hazmat Detection Systems | P3 | 3 | Ice+Lava+Temperate; Ice+Plasma+Temperate; Lava+Oceanic+Temperate; Oceanic+Plasma+Temperate (4 sets) |
| Hermetic Membranes | P3 | 3 | Gas+Ice+Temperate; Gas+Oceanic+Temperate (2 sets) |
| High-Tech Transmitters | P3 | 3 | Gas+Lava+Temperate; Gas+Plasma+Temperate (2 sets) |
| Industrial Explosives | P3 | 1 | Temperate (1 sets) |
| Neocoms | P3 | 3 | Barren+Gas+Lava (1 sets) |
| Nuclear Reactors | P3 | 3 | Barren+Lava+Temperate; Lava+Plasma+Temperate (2 sets) |
| Planetary Vehicles | P3 | 3 | Barren+Ice+Lava; Ice+Lava+Plasma (2 sets) |
| Robotics | P3 | 1 | Plasma (1 sets) |
| Smartfab Units | P3 | 1 | Lava (1 sets) |
| Supercomputers | P3 | 2 | Gas+Lava; Gas+Plasma; Lava+Storm; Plasma+Storm (4 sets) |
| Synthetic Synapses | P3 | 1 | Ice (1 sets) |
| Transcranial Microcontrollers | P3 | 1 | Barren (1 sets) |
| Ukomi Superconductors | P3 | 1 | Storm (1 sets) |
| Vaccines | P3 | 1 | Oceanic (1 sets) |
| Broadcast Node | P4 | 5 | Barren+Gas+Ice+Lava+Temperate; Barren+Gas+Lava+Oceanic+Temperate; Gas+Ice+Lava+Plasma+Temperate; Gas+Lava+Oceanic+Plasma+Temperate (4 sets) |
| Integrity Response Drones | P4 | 5 | Barren+Gas+Ice+Lava+Temperate; Barren+Gas+Lava+Oceanic+Temperate; Gas+Ice+Lava+Plasma+Temperate; Gas+Lava+Oceanic+Plasma+Temperate (4 sets) |
| Nano-Factory | P4 | 2 | Storm+Temperate (1 sets) |
| Organic Mortar Applicators | P4 | 3 | Barren+Gas+Lava; Barren+Gas+Plasma; Gas+Ice+Plasma; Gas+Oceanic+Plasma; Gas+Plasma+Temperate (5 sets) |
| Recursive Computing Module | P4 | 3 | Barren+Ice+Lava; Barren+Ice+Plasma; Gas+Oceanic+Plasma; Ice+Oceanic+Plasma; Ice+Plasma+Temperate; Oceanic+Plasma+Storm (6 sets) |
| Self-Harmonizing Power Core | P4 | 5 | Barren+Gas+Ice+Lava+Temperate; Barren+Gas+Lava+Oceanic+Temperate; Gas+Ice+Lava+Plasma+Temperate; Gas+Lava+Oceanic+Plasma+Temperate (4 sets) |
| Sterile Conduits | P4 | 2 | Lava+Oceanic (1 sets) |
| Wetware Mainframe | P4 | 3 | Gas+Lava+Oceanic; Gas+Lava+Temperate; Gas+Oceanic+Plasma; Gas+Plasma+Temperate; Lava+Oceanic+Storm; Lava+Storm+Temperate … (8 sets) |

### What each commodity feeds into
| Commodity | Tier | Used in |
|---|---|---|
| Bacteria | P1 | Fertilizer (P2), Nanites (P2), Organic Mortar Applicators (P4), Test Cultures (P2), Viral Agent (P2) |
| Biofuels | P1 | Biocells (P2), Livestock (P2), Polytextiles (P2) |
| Biomass | P1 | Genetically Enhanced Livestock (P2), Supertensile Plastics (P2), Viral Agent (P2) |
| Chiral Structures | P1 | Consumer Electronics (P2), Miniature Electronics (P2), Transmitter (P2) |
| Electrolytes | P1 | Coolant (P2), Rocket Fuel (P2), Synthetic Oil (P2) |
| Industrial Fibers | P1 | Microfiber Shielding (P2), Polyaramids (P2), Polytextiles (P2) |
| Oxidizing Compound | P1 | Oxides (P2), Polyaramids (P2), Silicate Glass (P2) |
| Oxygen | P1 | Oxides (P2), Supertensile Plastics (P2), Synthetic Oil (P2) |
| Plasmoids | P1 | Rocket Fuel (P2), Superconductors (P2), Transmitter (P2) |
| Precious Metals | P1 | Biocells (P2), Enriched Uranium (P2), Mechanical Parts (P2) |
| Proteins | P1 | Fertilizer (P2), Genetically Enhanced Livestock (P2), Livestock (P2) |
| Reactive Metals | P1 | Construction Blocks (P2), Mechanical Parts (P2), Nanites (P2), Nano-Factory (P4), Water-Cooled CPU (P2) |
| Silicon | P1 | Microfiber Shielding (P2), Miniature Electronics (P2), Silicate Glass (P2) |
| Toxic Metals | P1 | Construction Blocks (P2), Consumer Electronics (P2), Enriched Uranium (P2) |
| Water | P1 | Coolant (P2), Sterile Conduits (P4), Superconductors (P2), Test Cultures (P2), Water-Cooled CPU (P2) |
| Biocells | P2 | Gel-Matrix Biopaste (P3), Neocoms (P3), Transcranial Microcontrollers (P3) |
| Construction Blocks | P2 | Biotech Research Reports (P3), Smartfab Units (P3) |
| Consumer Electronics | P2 | Robotics (P3), Supercomputers (P3) |
| Coolant | P2 | Condensates (P3), Supercomputers (P3) |
| Enriched Uranium | P2 | Nuclear Reactors (P3) |
| Fertilizer | P2 | Cryoprotectant Solution (P3), Industrial Explosives (P3) |
| Genetically Enhanced Livestock | P2 | Hermetic Membranes (P3) |
| Livestock | P2 | Biotech Research Reports (P3), Vaccines (P3) |
| Mechanical Parts | P2 | Planetary Vehicles (P3), Robotics (P3) |
| Microfiber Shielding | P2 | Data Chips (P3), Nuclear Reactors (P3) |
| Miniature Electronics | P2 | Planetary Vehicles (P3), Smartfab Units (P3) |
| Nanites | P2 | Biotech Research Reports (P3), Transcranial Microcontrollers (P3) |
| Oxides | P2 | Condensates (P3), Gel-Matrix Biopaste (P3) |
| Polyaramids | P2 | Hermetic Membranes (P3), High-Tech Transmitters (P3) |
| Polytextiles | P2 | Hazmat Detection Systems (P3), Industrial Explosives (P3) |
| Rocket Fuel | P2 | Camera Drones (P3) |
| Silicate Glass | P2 | Camera Drones (P3), Neocoms (P3) |
| Superconductors | P2 | Gel-Matrix Biopaste (P3), Ukomi Superconductors (P3) |
| Supertensile Plastics | P2 | Data Chips (P3), Planetary Vehicles (P3), Synthetic Synapses (P3) |
| Synthetic Oil | P2 | Cryoprotectant Solution (P3), Ukomi Superconductors (P3) |
| Test Cultures | P2 | Cryoprotectant Solution (P3), Synthetic Synapses (P3) |
| Transmitter | P2 | Guidance Systems (P3), Hazmat Detection Systems (P3), High-Tech Transmitters (P3) |
| Viral Agent | P2 | Hazmat Detection Systems (P3), Vaccines (P3) |
| Water-Cooled CPU | P2 | Guidance Systems (P3), Supercomputers (P3) |
| Biotech Research Reports | P3 | Wetware Mainframe (P4) |
| Camera Drones | P3 | Self-Harmonizing Power Core (P4) |
| Condensates | P3 | Organic Mortar Applicators (P4) |
| Cryoprotectant Solution | P3 | Wetware Mainframe (P4) |
| Data Chips | P3 | Broadcast Node (P4) |
| Gel-Matrix Biopaste | P3 | Integrity Response Drones (P4) |
| Guidance Systems | P3 | Recursive Computing Module (P4) |
| Hazmat Detection Systems | P3 | Integrity Response Drones (P4) |
| Hermetic Membranes | P3 | Self-Harmonizing Power Core (P4) |
| High-Tech Transmitters | P3 | Broadcast Node (P4) |
| Industrial Explosives | P3 | Nano-Factory (P4) |
| Neocoms | P3 | Broadcast Node (P4) |
| Nuclear Reactors | P3 | Self-Harmonizing Power Core (P4) |
| Planetary Vehicles | P3 | Integrity Response Drones (P4) |
| Robotics | P3 | Organic Mortar Applicators (P4) |
| Smartfab Units | P3 | Sterile Conduits (P4) |
| Supercomputers | P3 | Wetware Mainframe (P4) |
| Synthetic Synapses | P3 | Recursive Computing Module (P4) |
| Transcranial Microcontrollers | P3 | Recursive Computing Module (P4) |
| Ukomi Superconductors | P3 | Nano-Factory (P4) |
| Vaccines | P3 | Sterile Conduits (P4) |

## 4. Where PI goods end up (SDE `blueprints.jsonl`, by product group)

This drives demand, so it's useful for an optimiser's "what sells" heuristics and for industry players who build
for their own use.

| Commodity | Main consumers |
|---|---|
| Coolant, Enriched Uranium, Mechanical Parts, Robotics, Oxygen | **Fuel blocks** (steady, large-volume demand) |
| Construction Blocks | T2 hulls (HACs, recons, logistics, interceptors, JFs, Marauders, Black Ops …) |
| Consumer Electronics, Miniature Electronics, Transmitter, Superconductors | T1/T2 module manufacturing (a very wide range) |
| Robotics | Weapons, launchers, drones, repairers |
| Rocket Fuel | T2 missiles |
| Guidance Systems | Drones, fighters, mobile deployables, probe launchers |
| Gel-Matrix Biopaste, Data Chips, Nanites | Nanite Repair Paste, boosters, implants |
| Synthetic Synapses, Transcranial Microcontrollers, Cryoprotectant Solution, Ukomi Superconductors | Implants, command bursts, Entosis Links |
| Biocells, Test Cultures, Viral Agent, Supertensile Plastics, Water, Chiral Structures | Construction components |
| All 8 P4 | Upwell structures and service modules, capital components, sovereignty hubs and upgrades, POS towers, deployables |

## 5. Optimising a specific planet (the core of the new feature)

The goal: given a planet and **how much of each resource it has**, decide what to extract and what to build there,
and how that planet fits with the player's other colonies, to maximise ISK/hour (or to feed a target product).

### 5.1 Where abundance data can come from

| Source | What it gives | Coverage |
|---|---|---|
| **ESI planet layout** (`/characters/{id}/planets/{planet_id}`) | For every *installed* extractor: product, `qty_per_cycle`, `cycle_time`, number of heads, head lat/long, `head_radius`, install/expiry time | Only planets the character already colonises, and only the P0 currently extracted. Data refreshes only when the colony is opened in game. |
| **Player scan readings** (input to the tool) | Relative abundance of each of the planet's 5 resources from the in-game scan view: a 0–100 value or low/medium/high, optionally the "hotspot" strength | Any planet the player can scan (Remote Sensing range). The model can read these from a screenshot of the scan window if the user pastes one. |
| **Observed history** (stored locally by the server) | `qty_per_cycle` per planet × P0 × date from repeated layout reads | Builds over time. Gives depletion and regen trends per planet. |
| **Priors** (none) | — | ESI/SDE have no per-planet richness. Without input, a planet type gives only *which* 5 resources exist, not how much. |

`qty_per_cycle` from ESI is the ground truth for extraction. Scan values are a proxy that must be calibrated. Once a
planet has an extractor, the optimiser should prefer the observed yield, and it can learn a per-character mapping
from "scan %" to `qty_per_cycle` for each head count and program length.

### 5.2 Model

For each candidate planet *p* (type known from the SDE, abundance `a[p][r]` for its 5 resources *r*):

1. **Extraction capacity.** Expected P0/h from one ECU with *h* heads on resource *r* over a program of length *T*:
   `yield(p,r,h,T) = Σ cycles of the decay formula (§1) with base ≈ k(h) · a[p][r]`. *k* is calibrated from observed
   ESI yields. Without calibration, use a conservative default and say so.
2. **CPU/PG budget** (CC level from the skill, structure costs from the SDE). Choose integers: ECUs (≤ ~2 in
   practice), heads per ECU (≤10), basic/advanced/high-tech factories, storage, launchpad and link lengths. The plan
   must fit CPU ≤ CC CPU and PG ≤ CC PG.
3. **Production graph.** Schematics from the SDE. Basics take 6,000 P0/h, so the P1 rate is
   `min(P0 supply, 6000 × basics) / 150`, and so on up the tiers with the §1 ratios. Inputs can be **imported**
   (from other colonies or the market) at import tax.
4. **Objective.** Maximise `Σ sell_price(output) × rate − Σ buy_price(imports) × rate − customs tax − upkeep` per
   hour. Alternatives: "maximise P4 X per week", "minimise logins" (longer programs, larger buffers), or "fit the
   haul in an Epithal".
5. **Across colonies and characters.** The unit of planning is a **colony slot**: (character, planet). Each
   character contributes 1 + Interplanetary Consolidation slots (max 6) and its own maximum CC level, and several
   characters can colonise the same planet. Choose one role per slot (extractor → P1, extractor → P2, P3/P4
   factory) so the whole account set closes a chain. §3 lists the minimum planet-type combinations for each product.
   See §5.5.

The search is small: 5 resources × 2 ECUs × a few factory counts × ~30 reachable products per planet type. Exhaustive
enumeration over the realistic templates (below) plus a greedy across-colony assignment is enough; no LP solver is
needed. Keep it deterministic and explain the pick: "Storm planet, Suspended Plasma 82% / Ionic 64%: 2 ECUs → Plasmoids
+ Electrolytes → Rocket Fuel, 4.1 P2/h, ≈ X ISK/day after 5% tax".

### 5.2a As built (`pi_optimize`)

- **Extraction colonies:** every resource pair on every planet (including two extractors on one resource). The most heads
  that fit the command center (CPU/PG from the SDE, CC levels from the client, 6% kept for links). The output is sold
  as P1 or combined into P2, whichever pays more. Yield = `p0_per_hour_at_100 × reading/100 × heads/10` (an assumption,
  shown in the output).
- **Factory colonies:** any P2-P4 product. Inputs come first from the plan's own colonies (forgoing their sale value
  and their export volume), and the rest are bought at the lowest sell order. Sized by the command center and by a
  restock interval that must fit the launchpad and one storage facility. Limited by the daily input budget, the daily
  haul budget, and the share of each item's daily market volume.
- **Assignment:** greedy by ISK/day over all characters' slots. Each character gets one colony per planet, extracting
  characters per planet are capped, and the same resource pair isn't extracted twice on one planet. A final pass
  re-splits factory inputs lowest tier first, so local output feeds factories before anything is bought.

### 5.2b Real yields (live data, Nov 2026)

Real colonies read live (wormhole space, 8 heads, one-day programs, 15-minute cycles) had `qty_per_cycle`
of 7,900-17,000, i.e. **23,600-53,000 P0/h per extractor** averaged over the program (29k-66k per 10 heads). That is
far more than two extractors' worth of basic factories can process at CC level 5, so the binding limit on an
extraction colony is CPU/PG for basic factories, not extraction. Those colonies ran 2 extractors into 4 basic
factories and piled up 0.5-1.3M unprocessed P0 in storage. `pi_optimize` therefore:

- defaults to 30,000 P0/h per 10 heads at a reading of 100, and calibrates itself (median) from the characters' own
  extractors in the target system on planets with scan readings;
- tries every head count with as many basic factories as still fit, and leaves surplus P0 unprocessed unless
  `export_raw_p0` is set.

### 5.2c Shared colony model (`src/pi-layout.ts`)

`pi_colony_calc` and `pi_optimize` use one deterministic model, so the optimiser's numbers can be checked colony by
colony:

- **Cost:** SDE CPU/PG per structure, plus heads beyond the first. Links cost 15 tf + 0.2 tf/km and 10 MW + 0.15 MW/km.
  Real colonies get real link lengths from pin latitude/longitude and the planet radius (SDE schema 6); otherwise 6% of
  the command center is kept for links.
- **Production:** an hour simulated tier by tier. Shared inputs are split in proportion to demand, and a factory runs at
  its scarcest input's share. Leftover P1+ is exported and leftover P0 stays on the planet.
- **Calculator suggestions:** the best single additions that still fit (by ISK/day). If the layout doesn't fit, the
  cheapest removals that make it fit.
- **Optimiser ranking:** greedy by ISK/day and greedy by ISK/day per share of the haul and input budgets; the better
  total wins. Ranking by ISK alone let one bulky factory use up the haul budget that a dozen extraction colonies could
  have used.
- **Local search:** after the greedy pass, each chosen colony (a resource pair on a planet, or a factory product) is
  banned in turn and the plan rebuilt; an improvement of more than 0.2% is kept and the search restarts, up to 80
  rebuilds. Static lookups are cached, so one rebuild of a 32-slot plan takes milliseconds. On the home system (Nov
  2026) it added 9% (80.9m → 87.3m ISK/day) by dropping seven extraction pairs that crowded out better ones.
- **Program length:** `program_hours` (and per character, `program_hours_by_character`) scales extraction by the
  factor in §1, and an extraction colony gets storage when a whole program's output won't fit its launchpad. Because
  the colonies are limited by basic factories rather than extraction, two-day programs cost the home system only
  8% (87.3m → 80.0m ISK/day), but the plan then buys more inputs (47m → 81m ISK/day).

### 5.2d Routes in real colonies (`planets`)

Factory inputs are checked against ESI routes, pin by pin: an input no route brings stops that factory (and its
output is removed from the colony's production); a factory fed straight from an extractor or another factory gets the
routed share of that source's output; a factory fed from storage or a launchpad uses the planet-wide balance. Output
from an extractor or factory that no route carries away is flagged. Checked live on 7 real colonies (all routed via
storage): no false alarms.

### 5.2e Setup sheets (`src/pi-setup.ts`)

`pi_optimize` with `setup_guide` (and `pi_colony_calc` for a layout that fits) turns each colony's layout into a build
sheet. The layout is a hub: every structure links to the launchpad, extractors deliver to it, and factories take their
inputs from it and return their output to it. Each sheet lists:

- what to place;
- each extractor's resource, heads, program and rate;
- each factory group's schematic and per-cycle input routes, with how busy it will be;
- what to bring in and collect each visit (factory inputs name the colonies that make them, or "bought");
- when spare P0 will fill the launchpad.

`haul_per_trip` totals the market buys and the sales for one restock interval.

### 5.2f Colony templates and saved plans (`src/pi-template.ts`, `src/pi-plan.ts`)

The client saves and imports colony templates (Planetary Industry view > Save as template / Open template > Import &
Export, from the clipboard or `.json` files in `Documents\EVE\PlanetaryInteractionTemplates`). CCP doesn't document the
format; it was read from client-saved templates (github.com/MattFalahe/EVE-PI-Templates) and checked against a real
colony from ESI, whose pins and routes map onto it one to one:

| Field | Meaning |
|---|---|
| `CmdCtrLv` | command center level |
| `Cmt` | template name |
| `Pln` | planet type id |
| `Diam` | diameter of the planet it was made for, km |
| `P` | structures (the command center is not one): `T` type, `La`/`Lo` position in radians, `S` product (factory) or P0 (extractor), `H` extractor heads |
| `L` | links: `S`/`D` 1-based indexes into `P`, `Lv` link level |
| `R` | routes: `P` path as 1-based indexes into `P` (source, waypoints, destination), `Q` quantity per cycle, `T` commodity |

Positions use ESI's convention: `La` is measured from the pole (0 to pi), so distances use the sine of it (the link
length in `pi_colony_calc` used the cosine before, which undercounted east-west links). Client-saved templates mix
structure types from other planet types, so the client evidently maps them on import; generated templates use the
target planet's own types. Head positions and programs aren't in templates.

Generated templates use the build sheets' hub: the launchpad in the middle, structures on a hex lattice 0.0122 rad
apart (what client-saved templates use), each linked to a neighbour one ring in (a factory or the launchpad where
possible), factories closest, extractors and storage outside. Every route runs through the launchpad. With the
planet's real size the link lengths are checked against the command center.

`pi_optimize save_as` freezes the chosen colonies, layouts included, in `<data dir>/pi-plans`. `pi_plans` and
`pi_plan_export` derive everything from the saved plan and static data only, so the sheets and templates are the same
on every call until the player replans.

The routine for every undock (`pi_plans`, and the build book's "Every undock" section) turns the saved plan into one
ordered run per character: extraction-only characters first, so the factories' inputs are in the shared hangar before
the factory characters fly; planets in orbit order; on each, restart the programs, launch and collect a visit's output,
and where each part goes (which factory colony, or the stockpile); then dock and drop it in the shared hangar. Factory
colonies are restocked every `restock_days` with the exact amount from each supplying colony. Each factory is filled
from its own character's colonies first (nothing to pass through the hangar), then from the colonies with the most to
spare, so inputs come from few places; ties go by orbit and name, so the split never changes. Cargo per run is given
for normal and factory days. It assumes the characters share a hangar (a corp hangar in the structure).

### 5.3 Layout templates the optimiser picks from

| Template | Structures (typical, CC level 4–5) | Use when |
|---|---|---|
| **P0→P1 extractor** | 2 ECUs (8–10 heads) + 2–3 basics + launchpad | One resource is very rich and P1 sells well, or P1 feeds a factory planet |
| **P0→P2 self-contained** | 2 ECUs on the two P0 of a single-planet P2 + 2–4 basics + 1 advanced + launchpad | Both P0 of a P2 are reasonably rich on the planet (see the single-planet P2 list) |
| **P1/P2→P3 factory** | Launchpad + 2 storage + 8–12 advanced | Imported P1/P2 from the other colonies. CPU/PG-light, no ECUs. |
| **P3→P4 factory** | Launchpad + high-tech plant(s) + advanced, Barren/Temperate only | Final step of a P4 chain |

Single-planet chains (all P0 on one planet type, from §3). These matter because they skip hauling between planets:

- **P2:** most P2 can be made on one planet type. The exceptions are Microfiber Shielding (Lava + Temperate),
  Polyaramids (Gas + Temperate) and Silicate Glass (Gas + Lava).
- **P3:** Condensates (Gas), Industrial Explosives (Temperate), Robotics (Plasma), Smartfab Units (Lava), Synthetic
  Synapses (Ice), Transcranial Microcontrollers (Barren), Ukomi Superconductors (Storm), Vaccines (Oceanic). Doing it
  from P0 on one planet needs 4 P0 types, which is more than 2 ECUs. In practice that means 2 extractor planets of the
  same type feeding one factory planet of any type.
- **P4 with the fewest planet types:** Nano-Factory (Storm + Temperate) and Sterile Conduits (Lava + Oceanic).

### 5.4 Practical optimisations to encode (advice output)

- Refine to at least P1 before export: about 4× less volume and a lower tax base.
- Route extractor output into storage or the launchpad, not straight into a factory, so overflow isn't lost.
- Match the program length to the login cadence. Daily: 1 day (15-min cycles). Every 3–4 days: 3–4 days. Shorter
  programs give more P0/h.
- Re-place heads when `qty_per_cycle` drops versus the last program (depletion). Spread heads to limit overlap.
- Highsec: train Customs Code Expertise (halves the NPC part at V) and prefer player POCOs with low tax. Null/WH:
  check corp POCO rates.
- Pick planets for the chain, not individually. The rare P0 (Autotrophs, Felsic Magma, Reactive Gas) and the rare
  planet types (Plasma, Oceanic, Ice) are usually the binding constraint.
- Use the launchpad, not the command center, for launches (×1.5 tax and a cooldown).
- Haulers with a Planetary Commodities hold (SDE attribute 1653, `specialPlanetaryCommoditiesHoldCapacity`, for
  example the Epithal) are what the haul-size check should use.

### 5.5 Multiple characters and wormhole PI

PI is planned for **all of the user's PI-capable characters together**, not one at a time. The server already
holds several logged-in characters (`characters_list`), so every PI tool works over all of them by default and
takes an optional `characters` filter.

**Per character, from ESI:**
- PI skills via `/characters/{id}/skills`: Interplanetary Consolidation (slots), Command Center Upgrades (CC
  level), Customs Code Expertise (highsec only, irrelevant in J-space), and Remote Sensing / Planetology.
- Existing colonies and layouts (`esi-planets.manage_planets.v1`).
- Location, used to tell which alts actually live in the hole.

A character missing the scope or with no PI skills is reported as such ("Alt C: Interplanetary Consolidation 0,
1 slot, CC max level 0") rather than silently dropped.

**Pooling.** Characters can't link colonies to each other. Goods move between alts through customs offices and a
shared hangar (a corp structure in the hole), so a cross-character transfer is a haul: export at one POCO, import at
another. The planner counts it as a transfer with tax at both ends and treats it as free in volume terms when both
alts are in the same system. With a corp-owned POCO at 0% tax, which is common in J-space, pooling is essentially
free. That makes the "N extractor alts feed one factory alt" pattern the natural wormhole layout.

**Many slots on the same planet.** With 5 alts × 6 slots = 30 slots and a hole typically having 6–12 planets, the
planner will put several characters on the best planet: for example, three alts each running 2 ECUs on the one Lava
for Felsic Magma. Whether extraction depletion is shared between characters on the same planet, or is per character,
isn't documented in the SDE/ESI. Verify it live (§6.4). Until then, the planner assumes shared depletion and warns
when it stacks characters on the same resource of the same planet.

**Wormhole specifics:**
- **The planet mix is fixed and known.** The starting point is "this hole has these planets" (SDE), so the
  question becomes "which chains does this system close, and how do we spread our alts across its planets?". This
  replaces a route-based planet search.
- **Shattered planets** (705 of them, almost all in J-space) can't be colonised. The lookup must flag them.
- **No NPC customs offices.** POCOs are player-owned (usually by the residents), so the tax is an input that defaults
  to 0% for the user's own corp. Tax rates are readable via `/corporations/{id}/customs_offices` for a director.
- **Hauling out is the cost.** Exports go through the chain, so prefer high value per m³ (P3/P4, or P2 that feeds
  fuel blocks and is consumed locally). The planner reports m³ per week to export and the number of hauler trips for a
  chosen hull.
- **Local consumption.** Fuel blocks (Coolant, Enriched Uranium, Mechanical Parts, Robotics, Oxygen) are often built
  in the hole for the corp's structures. "Fuel our own structures" is a valid goal alongside ISK/h.
- Wormhole class and effects (via `system_info` / the existing wormhole data) don't change PI mechanics. Show them
  for context only.

## 6. Implementation plan

### 6.1 SDE index additions (bump `SDE_SCHEMA_VERSION`)

**Shipped (schema 5):** only `pi_schematics` was needed. Pin types, planet restrictions and harvested P0 were already
in `types` / `type_attributes`, and `src/pi.ts` derives the model from them.


- `pi_schematics(id, name, cycle_s, output_type_id, output_qty)` and `pi_schematic_inputs(schematic_id, type_id, qty)`
  from `planetSchematics.jsonl`.
- `pi_pins(type_id, kind, planet_type_id, cpu, pg, harvest_type_id)` from types in groups 1026–1030 and 1063 plus
  dogma attributes 49/15, 1632 and 709. This gives the planet type → P0 matrix and the structure costs, with nothing
  hard-coded.
- `planets.type_id` already exists, so per-system planet lists and the distribution are already queryable.
- Tier comes from group: 1032/1033/1035 = P0, 1042 = P1, 1034 = P2, 1040 = P3, 1041 = P4. The tax base comes from
  attribute 1641.
- The client constants (CC levels, decay constants, storage volumes) go in one `pi-constants.ts` with a comment
  pointing at this doc.

### 6.2 Tools (one question per call; names, not ids)

| Tool | Question it answers | Data |
|---|---|---|
| `pi_product` | "How do I make X / what is X used for?": full tree to P0, planet types, minimum planet-type sets, balanced factory counts, volume and tax per unit, where it's used | SDE |
| ~~`pi_planet_options`~~ | Folded into `pi_system_planets` (`extra_planet_types` for what-if planet types, `single_planet_chains` per type), so the model has one tool to pick | — |
| `pi_system_planets` | "What PI can we do in this system?" (J-code or name, default the active character's location): every planet with name, type and colonisable flag (Shattered = no), the P0 present in the system, which P2/P3/P4 chains the system closes on its own and which planet type is missing for the rest, plus each of the user's characters' existing colonies there | SDE + ESI colonies |
| `pi_optimize` | "Given this planet and its resource levels (and my skills/colonies), what's the best setup?": §5 model, ranked plans with ISK/h, structure list, CPU/PG fit, program length | SDE + market prices + ESI layout + user abundance input |
| `planets` (extend) | Default to **all** logged-in characters (grouped by system), add per-extractor projected output and decay, per-planet input/output balance (deficit/surplus per commodity per hour), idle or starved factories, storage time-to-full, ISK/day estimate | ESI + SDE |
| `pi_colony_plan` | "With all my PI alts in this system, which character goes on which planet doing what, to make P4 X / max ISK/h / fuel our structures?": assigns (character, planet) slots and roles from each alt's skills and free slots, shows the cross-character transfers, export m³/week, and what each alt has to change | Composite of the above, all characters |

`pi_optimize` input sketch:

```jsonc
{
  "planet": "Jita IV",                         // or planet_type: "Storm"
  "abundance": { "Suspended Plasma": 82, "Ionic Solutions": 64, "Noble Gas": 20 },  // scan %, any subset
  "characters": "optional filter; default all PI-capable characters (skills, free slots, colonies)",
  "goal": "isk_per_hour | product:<name> | min_logins",
  "login_every_hours": 24,
  "customs_tax_pct": 0,                        // J-space POCOs are player-owned; default 0 for own corp
  "market": "jita"                             // price source for outputs and imports
}
```

Without `abundance` it uses observed `qty_per_cycle` if the character has a colony there. Otherwise it ranks options
by price × chain fit and says that yields are unknown. Output always states which numbers are observed, scanned or
assumed.

### 6.3 Tests

- SDE-backed: the planet → P0 matrix matches §3, all 68 schematics are present, P4 pins are only Barren/Temperate,
  and the minimal-set solver returns Storm + Temperate for Nano-Factory.
- Pure functions (cycle-time bracket, decay sum, CPU/PG fit, ratio math) get unit tests with known values from an
  in-game extractor once captured.
- Multi-character: the fake context with 2–3 characters with different skills/slots. `pi_colony_plan` must respect
  each alt's slot count and CC level, and must report a character without the PI scope instead of failing.
- Handler tests through the harness, with a fake ESI planet layout (extractor + factories + routes) for the extended
  `planets` and for `pi_optimize`'s observed-yield path.

### 6.4 Open questions / to verify live

- Capture one real extractor (`qty_per_cycle`, heads, program length) and the in-game per-cycle bars to confirm the
  decay formula, and set a 2-, 4- and 7-day program on the same spot to confirm the cycle brackets and whether
  `qty_per_cycle` changes with program length (the program-length model assumes it doesn't).
- Confirm the CC level CPU/PG/cost table and the storage volumes in game.
- Is extraction depletion shared between characters on the same planet, or per character? This decides whether
  stacking alts on one rich planet is free.
- Check that SSO refresh works with one process handling many characters in turn (the `live-testing-eve-esi` skill's
  token-rotation rule) when the PI tools fan out over every alt.
- Calibrate scan % → `qty_per_cycle`. The scan bar is visual only, so decide on 0–100 vs low/med/high input.
- POCO tax for offices the player doesn't own isn't in ESI. It has to be an input, or come from corp customs offices
  (`/corporations/{id}/customs_offices`, director role) when the player's corp owns it.
- Equinox Skyhooks and colony reagents (Magmatic Gas, Superionic Ice) are a separate system and out of scope here.
