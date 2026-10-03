// .dlg has no position of its own: .dlgback places it (layout.css), so a card rendered beside its shade instead
// of inside it lands in the page flow under the shade, and the owner sees only grey that any click dismisses.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("every .dlg card sits inside a .dlgback shade", async () => {
    const dir = new URL("../src/", import.meta.url);
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".tsx"));
    let cards = 0;
    for (const file of files) {
        const source = await readFile(new URL(file, dir), "utf8");
        for (const card of source.matchAll(/className="dlg[ "]/g)) {
            cards += 1;
            const before = source.slice(0, card.index);
            const shade = before.lastIndexOf('"mback');
            assert.ok(shade !== -1 && before.slice(shade).startsWith('"mback dlgback"'), `${file}: a .dlg card outside a .dlgback shade`);
        }
    }
    assert.ok(cards >= 2, "the confirm dialog and the models modal both render a .dlg card");
});
