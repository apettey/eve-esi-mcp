import assert from "node:assert/strict";
import { callTool, character, sde, testCtx, withSde } from "./harness.js";

const PILOT = character(90000301, "Fit Pilot");

withSde("fitting_delete deletes by exact name and hides the fit from ESI's cached list", async () => {
  const rifter = sde!.typeIdByName("Rifter")!;
  const fits = [
    { fitting_id: 11, name: "ZZ test - delete me", description: "", ship_type_id: rifter, items: [] },
    { fitting_id: 12, name: "Keeper", description: "", ship_type_id: rifter, items: [] },
  ];
  const ctx = testCtx({
    characters: [PILOT],
    esi: { [`GET /characters/${PILOT.id}/fittings`]: fits, [`DELETE /characters/${PILOT.id}/fittings/11`]: null },
  });
  const r = await callTool(ctx, "fitting_delete", { fitting: "zz test - DELETE me" });
  assert.deepEqual(r.json, { deleted: "ZZ test - delete me", ship: "Rifter", fitting_id: 11 });
  assert.equal(ctx.esi.callsTo(`/characters/${PILOT.id}/fittings/11`)[0].opts.scope, "esi-fittings.write_fittings.v1");

  // The fake keeps serving the old list, like ESI's cache does; the deleted fit must still be gone.
  const again = await callTool(ctx, "fitting_delete", { fitting: 11 });
  assert.equal(again.isError, true);
  assert.match(again.text, /No fitting "11"/);
});

withSde("fitting_delete refuses an ambiguous name without deleting anything", async () => {
  const rifter = sde!.typeIdByName("Rifter")!;
  const twin = (id: number) => ({ fitting_id: id, name: "Twin", description: "", ship_type_id: rifter, items: [] });
  const pilot = character(90000302, "Twin Pilot");
  const ctx = testCtx({ characters: [pilot], esi: { [`GET /characters/${pilot.id}/fittings`]: [twin(21), twin(22)] } });
  const r = await callTool(ctx, "fitting_delete", { fitting: "Twin" });
  assert.match(r.text, /Several fittings are named "Twin"; use the fitting_id/);
  assert.equal(ctx.esi.calls.filter((c) => c.method === "DELETE").length, 0);
});
