// Unit checks for the SaveKernel body builder. Usage, inside apps/web: node tests/save-kernel.test.mjs (Node 22.18+ strips the types).
import assert from "node:assert/strict";
import { buildSaveKernelBody, parseSettings, savedRef, validateCode } from "../lib/save-kernel.ts";

let passed = 0;
const ok = (name) => {
  passed++;
  console.log("  ✓", name);
};
const base = { ref: "u/nb", newTitle: null, kernelType: "script", code: "print(1)" };
const gpuNb = {
  datasetDataSources: ["a/b"],
  enableGpu: true,
  enableTpu: false,
  machineShape: "NvidiaTeslaT4",
  enableInternet: true,
  isPrivate: false,
  kernelType: "notebook",
};

let b = buildSaveKernelBody({ ...base, settings: { machine: "t4x2" }, current: null });
assert.equal(b.enableGpu, true);
assert.equal(b.machineShape, "NvidiaTeslaT4");
assert.equal(b.enableTpu, false);
ok("t4x2 → enableGpu + NvidiaTeslaT4");
b = buildSaveKernelBody({ ...base, settings: { machine: "tpu" }, current: null });
assert.equal(b.enableTpu, true);
assert.equal(b.enableGpu, false);
assert.equal(b.machineShape, "TpuV5E8");
ok("tpu → enableTpu + TpuV5E8");
b = buildSaveKernelBody({ ...base, settings: { machine: "cpu" }, current: gpuNb });
assert.equal(b.enableGpu, false);
assert.equal(b.enableTpu, false);
assert.ok(!("machineShape" in b));
ok("cpu overrides a GPU notebook and sends no machineShape");

b = buildSaveKernelBody({ ...base, settings: {}, current: gpuNb });
assert.deepEqual(b.datasetDataSources, ["a/b"]);
assert.equal(b.enableGpu, true);
assert.equal(b.machineShape, "NvidiaTeslaT4");
assert.equal(b.enableInternet, true);
assert.equal(b.isPrivate, false);
ok("inherits sources, GPU, internet and privacy from the current version");
b = buildSaveKernelBody({ ...base, settings: {}, current: { machineShape: "None", enableGpu: false } });
assert.equal(b.enableGpu, false);
assert.ok(!("machineShape" in b));
ok("inherited machineShape None stays CPU");
b = buildSaveKernelBody({ ...base, settings: { dataset_sources: [] }, current: gpuNb });
assert.deepEqual(b.datasetDataSources, []);
ok("explicit empty source list is sent as empty");
b = buildSaveKernelBody({ ...base, settings: { competition_sources: ["titanic"] }, current: gpuNb });
assert.deepEqual(b.datasetDataSources, ["a/b"]);
assert.deepEqual(b.competitionDataSources, ["titanic"]);
ok("one explicit list does not drop the others");

b = buildSaveKernelBody({
  ref: null,
  newTitle: "My exp",
  kernelType: "notebook",
  code: "{}",
  settings: {},
  current: null,
});
assert.equal(b.newTitle, "My exp");
assert.ok(!("slug" in b));
assert.equal(b.isPrivate, true);
assert.equal(b.enableGpu, false);
assert.ok(!("machineShape" in b));
assert.equal(b.enableInternet, false);
ok("new notebook: newTitle, private, CPU, no internet by default");
b = buildSaveKernelBody({ ...base, settings: {}, current: null });
assert.equal(b.slug, "u/nb");
assert.equal(b.kernelExecutionType, "SaveAndRunAll");
assert.equal(b.language, "python");
assert.equal(b.text, "print(1)");
assert.equal(b.kernelType, "script");
ok("existing notebook: slug, SaveAndRunAll, python, text is the code");

assert.deepEqual(parseSettings({ machine: "l4", enable_internet: true, dataset_sources: ["x/y"] }), {
  machine: "l4",
  enable_internet: true,
  dataset_sources: ["x/y"],
});
ok("parseSettings keeps only given fields");
assert.deepEqual(parseSettings(undefined), {});
ok("parseSettings(undefined) is empty");
assert.throws(() => parseSettings({ machine: "a100" }), /máy/i);
ok("unknown machine rejected");
assert.throws(() => parseSettings({ enable_internet: "yes" }));
ok("non-boolean flag rejected");
assert.throws(() => parseSettings({ dataset_sources: Array.from({ length: 21 }, (_, i) => `a/b${i}`) }));
ok("more than 20 sources rejected");
assert.throws(() => parseSettings({ dataset_sources: ["bad source!"] }));
ok("malformed source rejected");

assert.equal(validateCode("print(1)", "script"), "print(1)");
ok("valid script code");
assert.throws(() => validateCode("", "script"));
ok("empty code rejected");
assert.throws(() => validateCode("x".repeat(2 * 1024 * 1024 + 1), "script"), /2 MB/);
ok("code over 2 MB rejected");
assert.throws(() => validateCode("print(1)", "notebook"), /ipynb/);
ok("bad ipynb rejected");
assert.throws(() => validateCode("{}", "notebook"), /ipynb/);
ok("ipynb without cells rejected");
assert.equal(validateCode('{"cells":[]}', "notebook"), '{"cells":[]}');
ok("ipynb with cells accepted");

assert.equal(savedRef("/code/u/nb"), "u/nb");
assert.equal(savedRef("u/nb"), "u/nb");
assert.equal(savedRef(undefined), null);
assert.equal(savedRef("/code/bad ref"), null);
ok("savedRef strips /code/ and rejects malformed refs");

console.log(`\n${passed} checks passed`);
