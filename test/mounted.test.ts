// useMounted's body, read out of shared.ts and driven by stub hooks, since it only runs inside a render.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type Effect = () => () => void;

const shared = await readFile(new URL("../src/shared.ts", import.meta.url), "utf8");
const declared = /export function useMounted\(\): RefObject<boolean> \{([\s\S]*?)\n\}/.exec(shared);
assert.ok(declared, "shared.ts owns the mounted guard in one useMounted hook");
const hook = new Function("useRef", "useEffect", declared[1] as string) as
    (useRef: (initial: boolean) => { current: boolean }, useEffect: (effect: Effect) => void) => { current: boolean };

test("the hook arms the guard on mount and clears it on unmount", () => {
    const effects: Effect[] = [];
    const mounted = hook((initial) => ({ current: initial }), (effect) => effects.push(effect));

    assert.equal(mounted.current, true, "the first render already trusts the guard");
    assert.equal(effects.length, 1, "one effect, with no dependency that could re-run it");

    const effect = effects[0] as Effect;
    const discarded = effect();
    discarded();
    const cleanup = effect();
    assert.equal(mounted.current, true, "StrictMode's throwaway cleanup does not close the guard for the real mount");
    cleanup();
    assert.equal(mounted.current, false, "a reply that lands after unmount finds the guard closed");
});
