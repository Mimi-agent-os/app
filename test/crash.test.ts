// The root boundary under the real react-dom client, on a small fake DOM whose clicks go through React's delegated root listener.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";

// just enough DOM for react-dom/client: nodes, text, attributes, and the root's delegated listeners
class FakeNode {
    childNodes: FakeNode[] = [];
    parentNode: FakeNode | null = null;
    attributes = new Map<string, string>();
    listeners = new Map<string, ((event: object) => void)[]>();
    nodeValue = "";
    nodeType: number;
    nodeName: string;
    constructor(nodeType: number, nodeName: string) {
        this.nodeType = nodeType;
        this.nodeName = nodeName;
    }
    get ownerDocument(): FakeNode { return doc; }
    get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
    get nextSibling(): FakeNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
    get textContent(): string { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.textContent).join(""); }
    set textContent(text: string) {
        if (this.nodeType === 3) this.nodeValue = text;
        else this.childNodes = text ? [Object.assign(new FakeNode(3, "#text"), { nodeValue: text, parentNode: this })] : [];
    }
    appendChild(child: FakeNode): FakeNode { return this.insertBefore(child, null); }
    insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
        child.parentNode?.removeChild(child);
        this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, child);
        child.parentNode = this;
        return child;
    }
    removeChild(child: FakeNode): FakeNode {
        this.childNodes.splice(this.childNodes.indexOf(child), 1);
        child.parentNode = null;
        return child;
    }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    addEventListener(type: string, listener: (event: object) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    removeEventListener(): void {}
    find(tag: string): FakeNode[] { return [...(this.nodeName === tag ? [this] : []), ...this.childNodes.flatMap((c) => c.find(tag))]; }
}
const element = (tag: string): FakeNode =>
    Object.assign(new FakeNode(1, tag.toUpperCase()), { tagName: tag.toUpperCase(), namespaceURI: "http://www.w3.org/1999/xhtml", style: {} });
const doc: FakeNode = Object.assign(new FakeNode(9, "#document"), {
    defaultView: globalThis,
    createElement: element,
    createTextNode: (text: string) => Object.assign(new FakeNode(3, "#text"), { nodeValue: text }),
});
Object.assign(doc, { body: element("body"), documentElement: element("html") });
Object.assign(doc, { activeElement: (doc as unknown as { body: FakeNode }).body });

const stored = new Map<string, string>();
const replaced: string[] = [];
let reloads = 0;
Object.assign(globalThis, {
    window: globalThis,
    document: doc,
    HTMLIFrameElement: class {},
    localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
        removeItem: (key: string) => { stored.delete(key); },
    },
    history: { state: { i: 3 }, replaceState: (_state: unknown, _title: string, url: string) => { replaced.push(url); } },
    location: { reload: () => { reloads++; } },
});

const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { RootBoundary } = await import("../src/crash.ts");

// what a poisoned chat list left behind, next to what the device must keep
const DEVICE = {
    "mimi-os:chat-titles": JSON.stringify({ evil: [{ id: 1, title: { $$typeof: "x", evil: [1, 2] } }] }),
    "mimi-os:last-chat": JSON.stringify([["evil", 1]]),
    "mimi-os:last-place": "#/a/evil/1",
    "mimi-os:device": "{\"secret\":\"k\",\"gatewayPub\":\"p\"}",
    "mimi-os:theme": "light",
    "mimi-os:notify": "off",
    "mimi-os:dev": "on",
    "mimi-os:sidebar": "off",
    "mimi-os:collapsed": "[\"wren\"]",
    "mimi-os:settings-tab": "usage",
    "mimi-os:chat-queue:wren#3": "[\"later\"]",
};

// a chat row rendering the title an agent planted, as chat-row.tsx does: React throws "Objects are not valid as a React child"
const PlantedRow = (): ReturnType<typeof createElement> =>
    createElement("span", { className: "chat-title" }, { $$typeof: "x", evil: [1, 2] } as never);

async function crash(): Promise<{ root: FakeNode; caught: unknown[]; click: (label: string) => void }> {
    stored.clear();
    for (const [key, value] of Object.entries(DEVICE)) stored.set(key, value);
    replaced.length = 0;
    reloads = 0;
    const root = element("div");
    const caught: unknown[] = [];
    const react = createRoot(root as never, { onCaughtError: (error) => caught.push(error) });
    flushSync(() => react.render(createElement(RootBoundary, null, createElement("main", null, createElement(PlantedRow)))));
    const click = (label: string): void => {
        const target = root.find("BUTTON").find((b) => b.textContent === label);
        assert.ok(target, `no ${label} button`);
        for (const listener of root.listeners.get("click") ?? []) listener({ type: "click", target, bubbles: true, cancelable: true });
    };
    return { root, caught, click };
}

test("a render error anywhere below swaps the app for one calm screen with Reload and Clear cached lists", async () => {
    const { root, caught } = await crash();
    assert.match(String(caught[0]), /Objects are not valid as a React child/);
    const [screen] = root.childNodes;
    assert.equal(screen?.attributes.get("role"), "alert");
    assert.equal(screen?.attributes.get("class"), "crash");
    assert.equal(root.find("H3")[0]?.textContent, "Something went wrong");
    assert.deepEqual(root.find("BUTTON").map((b) => b.textContent), ["Reload", "Clear cached lists"]);
    assert.equal(root.find("MAIN").length, 0, "the broken tree is gone, not half drawn");
});

test("Reload reloads and forgets nothing", async () => {
    const { click } = await crash();
    click("Reload");
    assert.equal(reloads, 1);
    assert.deepEqual(replaced, []);
    assert.equal(stored.size, Object.keys(DEVICE).length);
});

test("Clear cached lists drops the cached chat lists and the last place, keeps the pairing and settings, and reloads at Home", async () => {
    const { click } = await crash();
    click("Clear cached lists");
    assert.deepEqual([...stored.keys()].sort(), Object.keys(DEVICE).filter((key) => !/chat-titles|last-chat|last-place/.test(key)).sort());
    assert.deepEqual(replaced, ["#/"]);
    assert.equal(reloads, 1);
});

test("until something throws, the boundary is invisible", async () => {
    const root = element("div");
    const react = createRoot(root as never);
    flushSync(() => react.render(createElement(RootBoundary, null, createElement("main", null, "the shell"))));
    assert.equal(root.textContent, "the shell");
});
