import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { Sde } from "../sde/db.js";
import { type Killmail, buildDoctrine, dronesInSpace, lossEft } from "../doctrine.js";
import { shipSlotCounts } from "../fit/model.js";
import { parseZkillUrl, relatedTime } from "../zkill.js";

test("zKillboard URLs map to API requests", () => {
  assert.deepEqual(parseZkillUrl("https://zkillboard.com/alliance/99003581/losses/"), {
    kind: "list", apiPath: "allianceID/99003581/losses/", members: { field: "alliance_id", id: 99003581 },
  });
  assert.deepEqual(parseZkillUrl("zkillboard.com/ship/22470/"), { kind: "list", apiPath: "shipTypeID/22470/", members: undefined });
  assert.deepEqual((parseZkillUrl("https://zkillboard.com/api/corporationID/98000001/kills/pastSeconds/3600/") as any).members, {
    field: "corporation_id", id: 98000001,
  });
  assert.deepEqual(parseZkillUrl("https://zkillboard.com/kill/139468923/"), { kind: "kill", id: 139468923 });
  assert.deepEqual(parseZkillUrl("https://zkillboard.com/related/30003067/202610270900/"), { kind: "related", systemId: 30003067, time: "202610270900" });
  assert.deepEqual(parseZkillUrl("https://br.evetools.org/related/30003067/202610270945"), { kind: "related", systemId: 30003067, time: "202610270900" });
  assert.throws(() => parseZkillUrl("https://br.evetools.org/br/5f00"), /related/);
  assert.throws(() => parseZkillUrl("https://example.com/alliance/1/"), /Unsupported/);
  assert.throws(() => parseZkillUrl("https://zkillboard.com/"), /No zKillboard filter/);
});

test("battle times floor to the hour in UTC", () => {
  assert.equal(relatedTime("2026-10-27 09:40"), "202610270900");
  assert.equal(relatedTime("2026-10-27T09:40:00+02:00"), "202610270700");
  assert.equal(relatedTime("202610270915"), "202610270900");
  assert.throws(() => relatedTime("yesterday"), /Unreadable/);
});

function openSde(): Sde | null {
  try {
    const pointer = join(loadConfig().home, "sde-current.json");
    if (!existsSync(pointer)) return null;
    const p = JSON.parse(readFileSync(pointer, "utf8"));
    return existsSync(p.path) ? new Sde(p.path) : null;
  } catch {
    return null;
  }
}
const sde = openSde();
const withSde = sde ? test : test.skip;
const id = (name: string) => {
  const t = sde!.typeIdByName(name);
  assert.ok(t, `type ${name}`);
  return t!;
};

// Killmail flags: low 11+, med 19+, high 27+, rig 92+, cargo 5, drone bay 87, implant 89.
function claymoreLoss(killmailId: number, victim: Partial<Killmail["victim"]>, attackers: Killmail["attackers"] = []): Killmail {
  return {
    killmail_id: killmailId,
    killmail_time: `2026-10-27T10:${String(killmailId % 60).padStart(2, "0")}:00Z`,
    solar_system_id: 30000142,
    victim: {
      ship_type_id: id("Claymore"),
      items: [
        { item_type_id: id("Shield Command Burst II"), flag: 27, quantity_destroyed: 1 },
        { item_type_id: id("Shield Harmonizing Charge"), flag: 27, quantity_destroyed: 50 },
        { item_type_id: id("Shield Harmonizing Charge"), flag: 27, quantity_dropped: 30 },
        { item_type_id: id("Heavy Assault Missile Launcher II"), flag: 28, quantity_dropped: 1 },
        { item_type_id: id("Scourge Rage Heavy Assault Missile"), flag: 28, quantity_destroyed: 20 },
        { item_type_id: id("Heavy Assault Missile Launcher II"), flag: 34, quantity_destroyed: 1 }, // past the rack
        { item_type_id: id("Large Shield Extender II"), flag: 19, quantity_destroyed: 1 },
        { item_type_id: id("Damage Control II"), flag: 11, quantity_destroyed: 1 },
        { item_type_id: id("Hobgoblin II"), flag: 87, quantity_destroyed: 10 },
        { item_type_id: id("Hammerhead II"), flag: 87, quantity_dropped: 2 },
        { item_type_id: id("Nanite Repair Paste"), flag: 5, quantity_dropped: 100 },
        { item_type_id: id("Shield Command Burst II"), flag: 5, quantity_dropped: 1 },
      ],
      ...victim,
    },
    attackers,
  };
}

withSde("loss EFT keeps fitted modules and loaded charges, drops cargo and extra drones", () => {
  const eft = lossEft(sde!, claymoreLoss(1, { character_id: 1 }))!;
  const lines = eft.split("\n");
  assert.equal(lines[0], "[Claymore, km 1]");
  assert.ok(lines.includes("Shield Command Burst II, Shield Harmonizing Charge"), eft);
  assert.ok(lines.includes("Heavy Assault Missile Launcher II, Scourge Rage Heavy Assault Missile"), eft);
  assert.equal(lines.filter((l) => l.startsWith("Heavy Assault Missile Launcher II")).length, 1, "module past the rack trimmed");
  assert.ok(!eft.includes("Nanite Repair Paste"), "cargo left out");
  assert.equal(lines.filter((l) => l.startsWith("Shield Command Burst II")).length, 1, "cargo burst left out");
  const highs = shipSlotCounts(sde!, id("Claymore")).high;
  assert.ok(highs < 8, "test relies on the Claymore having fewer than 8 highs");
  // 5 drones at most, within bandwidth.
  const drones = lines.filter((l) => / x\d+$/.test(l));
  const total = drones.reduce((n, l) => n + Number(/x(\d+)$/.exec(l)![1]), 0);
  assert.ok(total <= 5 && total > 0, eft);
});

withSde("drones in space respect bandwidth and the five-drone limit", () => {
  const ogre = id("Ogre II");
  const hob = id("Hobgoblin II");
  // Rifter: no bandwidth for heavies.
  assert.deepEqual(dronesInSpace(sde!, id("Rifter"), [{ type_id: ogre, quantity: 5 }]), []);
  const out = dronesInSpace(sde!, id("Vexor Navy Issue"), [{ type_id: hob, quantity: 12 }, { type_id: ogre, quantity: 3 }]);
  assert.equal(out.reduce((n, d) => n + d.quantity, 0) <= 5, true);
  assert.deepEqual(out[0], { type_id: hob, quantity: 5 });
});

withSde("doctrine groups members' hulls with unique pilots, EFTs per loss and weapons", () => {
  const ALLY = 99000001;
  const ENEMY = 99000002;
  const nighthawk = id("Nighthawk");
  const sabre = id("Sabre");
  const kms: Killmail[] = [
    claymoreLoss(10, { character_id: 1, alliance_id: ALLY }, [
      { character_id: 50, alliance_id: ENEMY, ship_type_id: nighthawk, weapon_type_id: id("Scourge Rage Heavy Assault Missile") },
    ]),
    claymoreLoss(11, { character_id: 2, alliance_id: ALLY }),
    // An enemy loss: our Sabre and Nighthawk pilots on the killmail, plus an NPC and a capsule.
    {
      killmail_id: 12,
      killmail_time: "2026-10-27T11:00:00Z",
      solar_system_id: 30000142,
      victim: { character_id: 60, alliance_id: ENEMY, ship_type_id: nighthawk, items: [] },
      attackers: [
        { character_id: 3, alliance_id: ALLY, ship_type_id: sabre, weapon_type_id: id("Heavy Assault Missile Launcher II") },
        { character_id: 3, alliance_id: ALLY, ship_type_id: sabre },
        { character_id: 4, alliance_id: ALLY, ship_type_id: nighthawk, weapon_type_id: nighthawk },
        { character_id: 5, alliance_id: ALLY, ship_type_id: id("Capsule") },
        { corporation_id: 1000125, ship_type_id: id("Claymore") },
      ],
    },
  ];
  const b = buildDoctrine(sde!, {
    name: "Test comp",
    description: "d",
    source: { type: "zkillboard", url: "u", kill_ids: [10, 11, 12], fetched_at: "now" },
    killmails: [...kms, kms[0]],
    isMember: (p) => p.alliance_id === ALLY,
    roster: [{ character_id: 7, ship_type_id: sabre }],
  });
  const by = Object.fromEntries(b.ships.map((s) => [s.ship, s]));
  assert.deepEqual(Object.keys(by).sort(), ["Claymore", "Nighthawk", "Sabre"]);
  assert.equal(by.Claymore.count, 2);
  assert.equal(by.Claymore.efts.length, 2, "one EFT per loss, duplicate killmail ignored");
  assert.equal(by.Sabre.count, 2, "same pilot counted once, roster adds one");
  assert.deepEqual(by.Sabre.efts, [], "attacker-only hull has no fit");
  assert.deepEqual(by.Sabre.weapons_seen, ["Heavy Assault Missile Launcher II"]);
  assert.equal(by.Nighthawk.count, 1, "enemy Nighthawks not counted");
  assert.equal(by.Nighthawk.weapons_seen, undefined, "weapon equal to the hull is not a weapon");
  assert.equal(b.ships[0].ship, "Claymore");
  for (const s of b.ships) assert.equal(s.label, s.ship);
  assert.deepEqual(Object.keys(b), ["name", "description", "source", "ships"]);
});
